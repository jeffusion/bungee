import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { installMasterSignalHandlers } from '../../src/master-runtime/signal-handlers';

class SignalSource extends EventEmitter {
  override on(event: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    return super.on(event, listener);
  }

  override off(event: 'SIGINT' | 'SIGTERM', listener: () => void): this {
    return super.off(event, listener);
  }
}

describe('master signal handlers', () => {
  test('installs once and shares one shutdown promise across both signals', async () => {
    const source = new SignalSource();
    let resolveShutdown = (): void => { throw new Error('shutdown resolver unavailable'); };
    const pending = new Promise<void>((resolve) => { resolveShutdown = resolve; });
    let calls = 0;
    const controller = installMasterSignalHandlers({
      runtime: { shutdown: () => { calls += 1; return pending; } },
      source,
      onError: () => undefined,
    });

    expect(source.listenerCount('SIGINT')).toBe(1);
    expect(source.listenerCount('SIGTERM')).toBe(1);
    source.emit('SIGINT');
    source.emit('SIGTERM');
    expect(controller.shutdown()).toBe(controller.shutdown());
    expect(calls).toBe(1);

    resolveShutdown();
    await controller.shutdown();
    controller.remove();
    expect(source.listenerCount('SIGINT')).toBe(0);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });

  test('reports one rejected shutdown and still removes handlers', async () => {
    const source = new SignalSource();
    const errors: unknown[] = [];
    const failure = new Error('shutdown failed');
    const controller = installMasterSignalHandlers({
      runtime: { shutdown: () => Promise.reject(failure) },
      source,
      onError: (error) => { errors.push(error); },
    });

    source.emit('SIGTERM');
    await controller.shutdown().catch(() => undefined);
    await Promise.resolve();
    controller.remove();

    expect(errors).toEqual([failure]);
    expect(source.listenerCount('SIGTERM')).toBe(0);
  });
});
