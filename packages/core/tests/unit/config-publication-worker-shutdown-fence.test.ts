import { expect, test } from 'bun:test';
import { createConfigWorkerRuntimeController } from '../../src/config-publication';
import { compileRuntimeConfigSnapshot } from '../../src/config-storage';
import {
  PROCESS_IDENTITY,
  fakeLifecycle,
  startMessage,
} from './config-publication-worker-runtime.fixtures';

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
