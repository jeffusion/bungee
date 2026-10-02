import { describe, expect, test } from 'bun:test';
import { createConfigWorkerRuntimeController as createRuntime } from '../../src/config-publication';
import {
  PROCESS_IDENTITY,
  expectMessage,
  fakeLifecycle,
  drainMessage,
  startMessage,
} from './config-publication-worker-runtime.fixtures';

const createConfigWorkerRuntimeController: typeof createRuntime = (options) => createRuntime({ ...options,
  bootId: 'linux:11111111-1111-4111-8111-111111111111', bootNonce: 'c0000000-0000-4000-8000-000000000001' });

describe('config worker fail-closed shutdown', () => {
  test('stops accepting then stops once and makes shutdown idempotent', async () => {
    // Given
    const fake = fakeLifecycle();
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fake.lifecycle,
    });
    expectMessage(await controller.apply(startMessage()));

    // When
    await Promise.all([controller.failClosed(), controller.failClosed()]);

    // Then
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'stop:1']);
  });

  test('never returns ready when shutdown races a pending start', async () => {
    // Given
    const fake = fakeLifecycle();
    fake.holdStart();
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fake.lifecycle,
    });
    const pending = controller.apply(startMessage());
    await fake.waitForStart();

    // When
    const shutdown = controller.failClosed();
    fake.releaseStart();
    const result = await pending;
    await shutdown;

    // Then
    expect(result).toMatchObject({ ok: false, error: { code: 'shutdown' } });
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'stop:1']);
  });

  test('never returns drained when shutdown races a pending drain', async () => {
    // Given
    const fake = fakeLifecycle();
    fake.holdDrain();
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: fake.lifecycle,
    });
    expectMessage(await controller.apply(startMessage()));
    const pending = controller.apply(drainMessage());
    await fake.waitForDrainStart();

    // When
    const shutdown = controller.failClosed();
    fake.releaseDrain();
    const result = await pending;
    await shutdown;

    // Then
    expect(result).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    expect(fake.calls).toEqual(['start', 'stop-accepting:1', 'drain:1', 'stop:1']);
  });
});
