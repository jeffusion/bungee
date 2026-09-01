import { describe, expect, test } from 'bun:test';
import { EventEmitter } from 'node:events';
import { createConfigWorkerProcessRuntime } from '../../src/config-publication';
import {
  FakeChannel,
  FakeController,
  IDENTITY,
  ManualScheduler,
  controlResponse,
  drainCommand,
  heartbeat,
  settle,
} from './config-worker-process-runtime.fixtures';

function runtime(overrides: {
  readonly channel?: FakeChannel;
  readonly controller?: FakeController;
  readonly scheduler?: ManualScheduler;
  readonly onControlResponse?: (message: ReturnType<typeof controlResponse>) => Promise<void>;
} = {}) {
  const channel = overrides.channel ?? new FakeChannel();
  const controller = overrides.controller ?? new FakeController();
  const scheduler = overrides.scheduler ?? new ManualScheduler();
  return {
    channel,
    controller,
    scheduler,
    runtime: createConfigWorkerProcessRuntime({
      identity: IDENTITY,
      masterPid: 4321,
      heartbeatTimeoutMs: 100,
      shutdownTimeoutMs: 25,
      channel,
      scheduler,
      controller,
      ...(overrides.onControlResponse === undefined
        ? {}
        : { onControlResponse: overrides.onControlResponse }),
    }),
  };
}

describe('config worker process runtime', () => {
  test('is inert until explicit start and never starts lifecycle without a snapshot', async () => {
    // Given
    const beforeSignals = process.listenerCount('SIGTERM');
    const harness = runtime();

    // When
    await import('../../src/config-publication/worker-process-runtime');

    // Then
    expect(harness.channel.subscriptionCalls).toEqual([]);
    expect(harness.scheduler.tasks).toEqual([]);
    expect(harness.controller.applied).toEqual([]);
    expect(process.listenerCount('SIGTERM')).toBe(beforeSignals);
  });

  test('start owns subscriptions and monotonic heartbeat replaces one-shot deadline', async () => {
    // Given
    const harness = runtime();
    await harness.runtime.start();

    // When
    harness.channel.emitMessage(heartbeat(1));
    harness.channel.emitMessage(heartbeat(2));
    await settle();

    // Then
    expect(harness.scheduler.tasks).toHaveLength(3);
    expect(harness.scheduler.tasks[0]?.timeout.cancelCalls).toBe(1);
    expect(harness.scheduler.tasks[1]?.timeout.cancelCalls).toBe(1);
    harness.scheduler.fire(0);
    harness.scheduler.fire(1);
    await settle();
    expect(harness.channel.exits).toEqual([]);
    harness.scheduler.fire(2);
    await settle();
    expect(harness.channel.exits).toEqual([1]);
  });

  test('fails closed for replay, wrong identity, wrong master, malformed input, or parent change', async () => {
    // Given / When / Then
    const cases = [
      (channel: FakeChannel) => { channel.emitMessage(heartbeat(1)); channel.emitMessage(heartbeat(1)); },
      (channel: FakeChannel) => channel.emitMessage(heartbeat(1, { ...IDENTITY, worker_slot: 3 })),
      (channel: FakeChannel) => channel.emitMessage(heartbeat(1, IDENTITY, 9999)),
      (channel: FakeChannel) => channel.emitMessage({ command: 'master-heartbeat' }),
      (channel: FakeChannel) => { channel.parentPid = 9999; channel.emitMessage(heartbeat(1)); },
    ];
    for (const trigger of cases) {
      const harness = runtime();
      await harness.runtime.start();
      trigger(harness.channel);
      await settle();
      expect(harness.controller.failClosedCalls).toBe(1);
      expect(harness.channel.exits).toEqual([1]);
    }
  });

  test('disconnect and signals share one idempotent cleanup path with distinct exit codes', async () => {
    // Given / When / Then
    for (const terminal of ['disconnect', 'SIGINT', 'SIGTERM'] as const) {
      const harness = runtime();
      await harness.runtime.start();
      if (terminal === 'disconnect') harness.channel.emitDisconnect();
      else harness.channel.emitSignal(terminal);
      harness.channel.emitDisconnect();
      await settle();
      expect(harness.controller.failClosedCalls).toBe(1);
      expect(harness.channel.exits).toEqual([terminal === 'disconnect' ? 1 : 0]);
      expect(harness.scheduler.tasks[0]?.timeout.cancelCalls).toBe(1);
      expect(harness.channel.subscriptionCalls.filter((call) => call.startsWith('unsubscribe'))).toHaveLength(4);
    }
  });

  test('serializes commands and awaits each successful send', async () => {
    // Given
    const harness = runtime();
    harness.controller.holdApply = true;
    harness.channel.holdSend = true;
    await harness.runtime.start();

    // When
    harness.channel.emitMessage(drainCommand());
    harness.channel.emitMessage(drainCommand());
    await settle();

    // Then
    expect(harness.controller.applied).toHaveLength(1);
    harness.controller.releaseApply?.();
    harness.controller.holdApply = false;
    await harness.channel.waitForSent(1);
    expect(harness.controller.applied).toHaveLength(1);
    harness.channel.releasePendingSend();
    await harness.controller.waitForApplied(2);
    await harness.channel.waitForSent(2);
    expect(harness.controller.applied).toHaveLength(2);
    expect(harness.channel.sent).toHaveLength(2);
  });

  test('fails closed when an awaited send rejects', async () => {
    // Given
    const commandHarness = runtime({
      onControlResponse: async () => {},
    });
    commandHarness.channel.sendFailure = new Error('IPC send failed');
    await commandHarness.runtime.start();

    // When
    commandHarness.channel.emitMessage(drainCommand());
    await commandHarness.channel.exited;

    // Then
    expect(commandHarness.controller.failClosedCalls).toBe(1);
    expect(commandHarness.channel.exits).toEqual([1]);
  });

  test('delegates control responses without feeding the lifecycle controller', async () => {
    // Given
    const handled: string[] = [];
    const harness = runtime({
      onControlResponse: async (message) => { handled.push(message.request_id); },
    });
    await harness.runtime.start();

    // When
    harness.channel.emitMessage(controlResponse());
    await settle();

    // Then
    expect(handled).toEqual(['request-1']);
    expect(harness.controller.applied).toEqual([]);
  });

  test('rejects a control response when no dedicated handler is installed', async () => {
    // Given
    const harness = runtime();
    await harness.runtime.start();

    // When
    harness.channel.emitMessage(controlResponse());
    await harness.channel.exited;

    // Then
    expect(harness.controller.applied).toEqual([]);
    expect(harness.controller.failClosedCalls).toBe(1);
    expect(harness.channel.exits).toEqual([1]);
  });

  test('preserves EventEmitter ordering for command then immediate disconnect', async () => {
    // Given
    const events = new EventEmitter();
    const harness = runtime();
    harness.channel.subscribeMessage = (listener) => {
      events.on('message', listener);
      return () => events.off('message', listener);
    };
    harness.channel.subscribeDisconnect = (listener) => {
      events.on('disconnect', listener);
      return () => events.off('disconnect', listener);
    };
    await harness.runtime.start();

    // When
    events.emit('message', drainCommand());
    events.emit('disconnect');
    await settle();

    // Then
    expect(harness.controller.failClosedCalls).toBe(1);
    expect(harness.controller.applied).toEqual([]);
    expect(harness.channel.exits).toEqual([1]);
  });
});
