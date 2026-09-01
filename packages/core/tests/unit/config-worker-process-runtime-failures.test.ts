import { describe, expect, test } from 'bun:test';
import {
  createConfigWorkerProcessRuntime,
  type ConfigProcessIdentity,
} from '../../src/config-publication';
import {
  FakeChannel,
  FakeController,
  IDENTITY,
  ManualScheduler,
} from './config-worker-process-runtime.fixtures';

function createHarness(input: {
  readonly identity?: ConfigProcessIdentity;
  readonly masterPid?: number;
  readonly timeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly channel?: FakeChannel;
  readonly controller?: FakeController;
  readonly scheduler?: ManualScheduler;
} = {}) {
  const channel = input.channel ?? new FakeChannel();
  const controller = input.controller ?? new FakeController();
  const scheduler = input.scheduler ?? new ManualScheduler();
  return {
    channel,
    controller,
    scheduler,
    runtime: createConfigWorkerProcessRuntime({
      identity: input.identity ?? IDENTITY,
      masterPid: input.masterPid ?? 4321,
      heartbeatTimeoutMs: input.timeoutMs ?? 100,
      shutdownTimeoutMs: input.shutdownTimeoutMs ?? 25,
      channel,
      controller,
      scheduler,
    }),
  };
}

describe('config worker process runtime failure containment', () => {
  test('rejects invalid identity, master pid, timeout, or initial parent before subscribing', async () => {
    // Given
    const wrongParent = new FakeChannel();
    wrongParent.parentPid = 9999;
    const cases = [
      createHarness({ identity: { ...IDENTITY, worker_slot: -1 } }),
      createHarness({ identity: { ...IDENTITY, master_generation: 'INVALID' } }),
      createHarness({ masterPid: 0 }),
      createHarness({ masterPid: Number.MAX_SAFE_INTEGER + 1 }),
      createHarness({ timeoutMs: 0 }),
      createHarness({ timeoutMs: 1.5 }),
      createHarness({ shutdownTimeoutMs: 0 }),
      createHarness({ shutdownTimeoutMs: Number.MAX_SAFE_INTEGER + 1 }),
      createHarness({ channel: new FakeChannel(0) }),
      createHarness({ channel: wrongParent }),
    ];

    // When / Then
    for (const harness of cases) {
      await harness.runtime.start();
      expect(harness.channel.subscriptionCalls).toEqual([]);
      expect(harness.controller.failClosedCalls).toBe(1);
      expect(harness.channel.exits).toEqual([1]);
    }
  });

  test('contains timer setup and parent pid getter exceptions', async () => {
    // Given
    const scheduleFailure = createHarness();
    scheduleFailure.scheduler.scheduleFailure = new Error('schedule failed');
    const parentFailureChannel = new FakeChannel();
    parentFailureChannel.parentPidFailure = new Error('parent lookup failed');
    const parentFailure = createHarness({ channel: parentFailureChannel });

    // When / Then
    for (const harness of [scheduleFailure, parentFailure]) {
      await harness.runtime.start();
      expect(harness.controller.failClosedCalls).toBe(1);
      expect(harness.channel.exits).toEqual([1]);
    }
  });

  test('contains every subscription exception and cleans earlier resources', async () => {
    // Given / When / Then
    for (const failure of ['message', 'disconnect', 'SIGINT', 'SIGTERM']) {
      const channel = new FakeChannel();
      channel.subscribeFailure = failure;
      const harness = createHarness({ channel });

      await harness.runtime.start();

      expect(harness.controller.failClosedCalls).toBe(1);
      expect(harness.scheduler.tasks[0]?.timeout.cancelCalls).toBe(1);
      expect(channel.exits).toEqual([1]);
    }
  });

  test('contains cancel, unsubscribe, controller shutdown, and exit exceptions together', async () => {
    // Given
    const harness = createHarness();
    await harness.runtime.start();
    harness.scheduler.cancelFailure = new Error('cancel failed');
    harness.channel.unsubscribeFailure = new Error('unsubscribe failed');
    harness.controller.failClosedFailure = new Error('shutdown failed');
    harness.channel.exitFailure = new Error('exit failed');

    // When
    harness.channel.emitDisconnect();
    await Promise.resolve();
    await Promise.resolve();

    // Then
    expect(harness.controller.failClosedCalls).toBe(1);
    expect(harness.channel.exits).toEqual([1]);
    expect(harness.channel.subscriptionCalls.filter((call) => call.startsWith('unsubscribe'))).toHaveLength(4);
  });

  test('cleans resources returned after synchronous scheduler or subscription termination', async () => {
    // Given
    const synchronousTimer = createHarness();
    synchronousTimer.scheduler.fireDuringSchedule = true;
    const synchronousMessageChannel = new FakeChannel();
    synchronousMessageChannel.messageDuringSubscribe = { invalid: true };
    const synchronousMessage = createHarness({ channel: synchronousMessageChannel });

    // When
    await synchronousTimer.runtime.start();
    await synchronousMessage.runtime.start();
    await synchronousMessage.channel.exited;

    // Then
    expect(synchronousTimer.scheduler.tasks[0]?.timeout.cancelCalls).toBe(1);
    expect(synchronousTimer.channel.exits).toEqual([1]);
    expect(synchronousMessage.channel.subscriptionCalls).toContain('unsubscribe:message');
    expect(synchronousMessage.channel.exits).toEqual([1]);
  });
});
