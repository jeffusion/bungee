import { describe, expect, test } from 'bun:test';
import { createConfigWorkerProcessRuntime } from '../../src/config-publication';
import {
  FakeChannel,
  FakeController,
  IDENTITY,
  ManualScheduler,
  settle,
} from './config-worker-process-runtime.fixtures';
import { startMessage } from './config-publication-worker-runtime.fixtures';

function createHarness() {
  const channel = new FakeChannel();
  const controller = new FakeController();
  const scheduler = new ManualScheduler();
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
      controller,
      scheduler,
    }),
  };
}

describe('config worker orphan shutdown watchdog', () => {
  test('exits once when apply and failClosed never settle', async () => {
    // Given
    const harness = createHarness();
    harness.controller.holdApply = true;
    harness.controller.holdFailClosed = true;
    await harness.runtime.start();
    harness.channel.emitMessage({ ...startMessage(), ...IDENTITY });
    await harness.controller.waitForApplied(1);

    // When
    harness.scheduler.fire(0);
    harness.scheduler.fire(1);
    await settle();

    // Then
    expect(harness.controller.failClosedCalls).toBe(1);
    expect(harness.channel.exits).toEqual([1]);
    harness.controller.releasePendingFailClosed();
    harness.controller.releaseApply?.();
    await settle();
    expect(harness.channel.exits).toEqual([1]);
  });

  test('normal failClosed cancels watchdog and exits once', async () => {
    // Given
    const harness = createHarness();
    await harness.runtime.start();

    // When
    harness.channel.emitDisconnect();
    await settle();
    harness.scheduler.fire(1);

    // Then
    expect(harness.scheduler.tasks[1]?.timeout.cancelCalls).toBe(1);
    expect(harness.channel.exits).toEqual([1]);
  });

  test('retries exit after watchdog exit throws and failClosed later settles', async () => {
    // Given
    const harness = createHarness();
    harness.controller.holdFailClosed = true;
    harness.channel.exitFailure = new Error('exit failed');
    await harness.runtime.start();
    harness.channel.emitDisconnect();

    // When
    harness.scheduler.fire(1);
    await settle();
    harness.channel.exitFailure = undefined;
    harness.controller.releasePendingFailClosed();
    await settle();

    // Then
    expect(harness.channel.exits).toEqual([1, 1]);
  });

  test('contains watchdog schedule and cancellation errors', async () => {
    // Given
    const scheduleFailure = createHarness();
    scheduleFailure.scheduler.scheduleFailureCall = 2;
    const cancelFailure = createHarness();
    cancelFailure.scheduler.cancelFailure = new Error('cancel failed');
    await scheduleFailure.runtime.start();
    await cancelFailure.runtime.start();

    // When
    scheduleFailure.channel.emitDisconnect();
    cancelFailure.channel.emitDisconnect();
    await settle();

    // Then
    expect(scheduleFailure.controller.failClosedCalls).toBe(1);
    expect(scheduleFailure.scheduler.scheduleCalls).toBe(2);
    expect(scheduleFailure.scheduler.tasks[0]?.timeout.cancelCalls).toBe(1);
    expect(scheduleFailure.channel.subscriptionCalls.filter((call) => call.startsWith('unsubscribe'))).toHaveLength(4);
    expect(scheduleFailure.channel.exits).toEqual([1]);
    expect(cancelFailure.controller.failClosedCalls).toBe(1);
    expect(cancelFailure.scheduler.tasks[1]?.timeout.cancelCalls).toBe(1);
    expect(cancelFailure.channel.exits).toEqual([1]);
  });
});
