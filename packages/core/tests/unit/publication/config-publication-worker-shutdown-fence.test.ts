import { expect, test } from 'bun:test';
import { createConfigWorkerRuntimeController as createRuntime } from '../../../src/config-publication';
import { compileRuntimeConfigSnapshot } from '../../../src/config-storage';
import {
  PROCESS_IDENTITY,
  drainMessage,
  fakeLifecycle,
  startMessage,
} from '../../helpers/config-publication-worker-runtime.ts';

const createConfigWorkerRuntimeController: typeof createRuntime = (options) => createRuntime({ ...options,
  bootId: 'linux:11111111-1111-4111-8111-111111111111', bootNonce: 'c0000000-0000-4000-8000-000000000001' });

test('shutdown requested during compile fences lifecycle startup', async () => {
  let releaseCompile: (() => void) | undefined;
  let markCompiling: (() => void) | undefined;
  const compiling = new Promise<void>((resolve) => { markCompiling = resolve; });
  const compileGate = new Promise<void>((resolve) => { releaseCompile = resolve; });
  const fake = fakeLifecycle();
  const controller = createConfigWorkerRuntimeController({
    pid: 4321,
    identity: PROCESS_IDENTITY,
    lifecycle: fake.lifecycle,
    async compileSnapshot(snapshot) {
      markCompiling?.();
      await compileGate;
      return compileRuntimeConfigSnapshot(snapshot);
    },
  });

  const applying = controller.apply(startMessage());
  await compiling;
  const shutdown = controller.failClosed();
  releaseCompile?.();
  const result = await applying;
  await shutdown;

  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('shutdown must not publish a worker message');
  expect(result.error.code).toBe('shutdown');
  expect(fake.calls).toEqual([]);
});

test('failClosed bypasses a held drain and shares one cleanup promise', async () => {
  for (const rejectDrain of [false, true]) {
    const fake = fakeLifecycle();
    fake.holdDrain();
    let stopCalls = 0;
    const controller = createConfigWorkerRuntimeController({
      pid: 4321,
      identity: PROCESS_IDENTITY,
      lifecycle: {
        ...fake.lifecycle,
        async drain(handle) {
          await fake.lifecycle.drain(handle);
          if (rejectDrain) throw new Error('drain interrupted');
        },
        async stop(handle) {
          stopCalls += 1;
          fake.releaseDrain();
          await fake.lifecycle.stop(handle);
        },
      },
    });

    const start = await controller.apply(startMessage());
    expect(start.ok).toBe(true);
    const draining = controller.apply(drainMessage());
    await fake.waitForDrainStart();
    const first = controller.failClosed();
    const second = controller.failClosed();
    expect(first).toBe(second);
    const drain = await draining;
    expect(drain).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    await first;
    expect(controller.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
    expect(stopCalls).toBe(1);
  }
});

test('failClosed propagates delayed cleanup failure from an in-flight start', async () => {
  const fake = fakeLifecycle();
  fake.holdStart();
  const cleanupError = new Error('start cleanup failed');
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupGate = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  const cleanupReady = new Promise<void>((resolve) => { cleanupStarted = resolve; });
  const controller = createConfigWorkerRuntimeController({
    pid: 4321,
    identity: PROCESS_IDENTITY,
    lifecycle: {
      ...fake.lifecycle,
      async stop(handle) {
        cleanupStarted();
        await cleanupGate;
        await fake.lifecycle.stop(handle);
        throw cleanupError;
      },
    },
  });
  const applying = controller.apply(startMessage()).then(() => null, (error) => error);
  await fake.waitForStart();
  const first = controller.failClosed();
  const second = controller.failClosed();
  expect(first).toBe(second);
  fake.releaseStart();
  await cleanupReady;
  const early = await Promise.race([first.then(() => false, () => false), Bun.sleep(20).then(() => true)]);
  expect(early).toBe(true);
  releaseCleanup();
  const [applyError, shutdownError] = await Promise.all([applying, first.then(() => null, (error) => error)]);
  expect(applyError).toBe(cleanupError);
  expect(shutdownError).toBeInstanceOf(AggregateError);
  expect(shutdownError.errors).toContain(cleanupError);
});

test('drain resolve and reject keep their ordinary outcomes until shutdown fences them', async () => {
  const resolved = fakeLifecycle();
  const resolvedController = createConfigWorkerRuntimeController({ pid: 4321, identity: PROCESS_IDENTITY, lifecycle: resolved.lifecycle });
  const started = await resolvedController.apply(startMessage());
  expect(started.ok).toBe(true);
  const drained = await resolvedController.apply(drainMessage());
  expect(drained.ok).toBe(true);
  for (let i = 0; i < 16; i++) await Promise.resolve();
  expect(resolvedController.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-drained' } });
  await resolvedController.failClosed();

  const rejected = fakeLifecycle();
  const rejectedController = createConfigWorkerRuntimeController({
    pid: 4321,
    identity: PROCESS_IDENTITY,
    lifecycle: { ...rejected.lifecycle, async drain() { throw new Error('drain failed'); } },
  });
  await rejectedController.apply(startMessage());
  const failed = await rejectedController.apply(drainMessage());
  expect(failed).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
  expect(rejectedController.drainStatus()).toMatchObject({ ok: true, message: { status: 'worker-draining' } });
  await rejectedController.failClosed();
});
