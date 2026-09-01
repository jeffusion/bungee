import { describe, expect, test } from 'bun:test';
import { ChildProcess } from 'node:child_process';
import {
  NodeChildProcessAdapter,
  NodeChildProcessAdapterError,
} from '../../src/config-publication/node-child-process';
import type { ConfigMasterMessage, ConfigProcessIdentity } from '../../src/config-publication/messages';

const IDENTITY: ConfigProcessIdentity = {
  master_generation: '10000000-0000-4000-8000-000000000001',
  worker_instance_id: '20000000-0000-4000-8000-000000000001',
  worker_slot: 3,
};

const COMMAND: ConfigMasterMessage = {
  command: 'drain-worker', ...IDENTITY, revision: 7,
  content_hash: `sha256:${'a'.repeat(64)}`,
  plugin_catalog_hash: `sha256:${'b'.repeat(64)}`, publication: null,
};

function childProcess(pid = 4321): ChildProcess {
  const child = new ChildProcess();
  Object.defineProperty(child, 'pid', { configurable: true, value: pid });
  Object.defineProperty(child, 'connected', { configurable: true, value: true, writable: true });
  return child;
}

describe('NodeChildProcessAdapter', () => {
  test('settles send from callback and treats false as backpressure only', async () => {
    // Given
    const child = childProcess();
    let callback: ((error: Error | null) => void) | undefined;
    Object.defineProperty(child, 'send', {
      configurable: true,
      value(_message: unknown, pending: (error: Error | null) => void) {
        callback = pending;
        return false;
      },
    });
    const adapter = new NodeChildProcessAdapter(child, IDENTITY);

    // When
    let settled = false;
    const pending = adapter.send(COMMAND).then(() => { settled = true; });
    await Promise.resolve();

    // Then
    expect(settled).toBeFalse();
    callback?.(null);
    await pending;
    expect(settled).toBeTrue();
  });

  test('rejects callback errors, synchronous throws, and disconnected sends', async () => {
    for (const mode of ['callback', 'throw', 'disconnected'] as const) {
      const child = childProcess();
      if (mode === 'disconnected') Object.defineProperty(child, 'connected', { value: false });
      Object.defineProperty(child, 'send', {
        configurable: true,
        value(_message: unknown, callback: (error: Error | null) => void) {
          if (mode === 'throw') throw new Error('send threw');
          callback(mode === 'callback' ? new Error('callback failed') : null);
          return true;
        },
      });
      const adapter = new NodeChildProcessAdapter(child, IDENTITY);

      expect(adapter.send(COMMAND)).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
    }
  });

  test('replays one exact exit and unsubscribes exact message listeners', () => {
    const child = childProcess();
    const adapter = new NodeChildProcessAdapter(child, IDENTITY);
    const messages: unknown[] = [];
    const unsubscribe = adapter.subscribeMessage((message) => { messages.push(message); });
    child.emit('message', { status: 'other' });
    unsubscribe();
    child.emit('message', { status: 'ignored' });
    child.emit('exit', 0, null);
    const exits: number[] = [];

    adapter.subscribeExit(({ pid }) => { exits.push(pid); });
    child.emit('exit', 1, null);

    expect(messages).toEqual([{ status: 'other' }]);
    expect(exits).toEqual([4321]);
  });

  test('uses ChildProcess signal contract for graceful and force requests', async () => {
    const child = childProcess();
    const signals: NodeJS.Signals[] = [];
    Object.defineProperty(child, 'kill', {
      configurable: true,
      value(signal: NodeJS.Signals) { signals.push(signal); return signal === 'SIGTERM'; },
    });
    const adapter = new NodeChildProcessAdapter(child, IDENTITY);

    await adapter.terminate('graceful');
    expect(adapter.terminate('force')).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  test('rejects a pending and every later send on each terminal event', async () => {
    // Given / When / Then
    for (const terminal of ['exit', 'disconnect', 'error'] as const) {
      const child = childProcess();
      Object.defineProperty(child, 'send', {
        configurable: true,
        value(_message: unknown, _callback: (error: Error | null) => void) { return true; },
      });
      const adapter = new NodeChildProcessAdapter(child, IDENTITY);
      const pending = adapter.send(COMMAND);

      if (terminal === 'error') child.emit('error', new Error('child failed'));
      else child.emit(terminal, terminal === 'exit' ? 0 : undefined, null);

      expect(pending).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(adapter.send(COMMAND)).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(terminal === 'exit' ? 0 : 1);
      expect(child.listenerCount('disconnect')).toBe(0);
      expect(child.listenerCount('error')).toBe(terminal === 'exit' ? 0 : 1);
      if (terminal !== 'exit') child.emit('exit', 0, null);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
    }
  });

  test('retains exact exit ownership after IPC disconnect or error', async () => {
    // Given / When / Then
    for (const terminal of ['disconnect', 'error'] as const) {
      const child = childProcess();
      Object.defineProperty(child, 'send', {
        configurable: true,
        value(_message: unknown, _callback: (error: Error | null) => void) { return true; },
      });
      const adapter = new NodeChildProcessAdapter(child, IDENTITY);
      const pending = adapter.send(COMMAND);

      if (terminal === 'error') child.emit('error', new Error('child failed'));
      else child.emit('disconnect');

      expect(pending).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(adapter.send(COMMAND)).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(child.listenerCount('exit')).toBe(1);
      child.emit('exit', 0, null);
      const exits: number[] = [];
      adapter.subscribeExit(({ pid }) => { exits.push(pid); });
      child.emit('exit', 1, 'SIGKILL');

      expect(exits).toEqual([4321]);
      expect(child.listenerCount('exit')).toBe(0);
    }
  });

  test('guards repeated errors until exact exit fully disposes listeners', async () => {
    // Given / When / Then
    for (const firstTerminal of ['error', 'disconnect'] as const) {
      const child = childProcess();
      Object.defineProperty(child, 'send', {
        configurable: true,
        value(_message: unknown, _callback: (error: Error | null) => void) { return true; },
      });
      const adapter = new NodeChildProcessAdapter(child, IDENTITY);
      const pending = adapter.send(COMMAND);

      if (firstTerminal === 'error') child.emit('error', new Error('first terminal error'));
      else child.emit('disconnect');

      expect(pending).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(adapter.send(COMMAND)).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
      expect(() => child.emit('error', new Error('repeated terminal error'))).not.toThrow();
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('disconnect')).toBe(0);
      expect(child.listenerCount('error')).toBe(1);
      expect(child.listenerCount('exit')).toBe(1);

      child.emit('exit', 0, null);
      const exits: number[] = [];
      adapter.subscribeExit(({ pid }) => { exits.push(pid); });
      child.emit('exit', 1, 'SIGKILL');

      expect(exits).toEqual([4321]);
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('disconnect')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
    }
  });

  test('settles send once when callback and terminal errors race', async () => {
    // Given
    const errorFirstChild = childProcess();
    let lateCallback: ((error: Error | null) => void) | undefined;
    Object.defineProperty(errorFirstChild, 'send', {
      configurable: true,
      value(_message: unknown, callback: (error: Error | null) => void) {
        lateCallback = callback;
        return true;
      },
    });
    const errorFirst = new NodeChildProcessAdapter(errorFirstChild, IDENTITY);
    const rejected = errorFirst.send(COMMAND);

    // When
    errorFirstChild.emit('error', new Error('terminal'));
    lateCallback?.(null);

    // Then
    expect(rejected).rejects.toBeInstanceOf(NodeChildProcessAdapterError);

    const callbackFirstChild = childProcess();
    Object.defineProperty(callbackFirstChild, 'send', {
      configurable: true,
      value(_message: unknown, callback: (error: Error | null) => void) {
        callback(null);
        return true;
      },
    });
    const callbackFirst = new NodeChildProcessAdapter(callbackFirstChild, IDENTITY);
    await callbackFirst.send(COMMAND);
    callbackFirstChild.emit('error', new Error('later terminal'));
    expect(callbackFirst.send(COMMAND)).rejects.toBeInstanceOf(NodeChildProcessAdapterError);
  });

  test('keeps exact exit replay after terminal listener disposal and ignores repeats', () => {
    // Given
    const child = childProcess();
    const adapter = new NodeChildProcessAdapter(child, IDENTITY);
    const observed: number[] = [];
    const unsubscribe = adapter.subscribeExit(({ pid }) => { observed.push(pid); });
    unsubscribe();

    // When
    child.emit('exit', 0, null);
    child.emit('exit', 1, 'SIGKILL');
    adapter.subscribeExit(({ pid }) => { observed.push(pid); });

    // Then
    expect(observed).toEqual([4321]);
    expect(child.listenerCount('exit')).toBe(0);
  });

  test('does not signal again when exact exit is already recorded', async () => {
    // Given
    const child = childProcess();
    const signals: NodeJS.Signals[] = [];
    Object.defineProperty(child, 'kill', {
      configurable: true,
      value(signal: NodeJS.Signals) { signals.push(signal); return false; },
    });
    const adapter = new NodeChildProcessAdapter(child, IDENTITY);
    child.emit('exit', 0, null);

    // When
    await adapter.terminate('graceful');
    await adapter.terminate('force');

    // Then
    expect(signals).toEqual([]);
  });
});
