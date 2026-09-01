import { expect, test } from 'bun:test';
import { createConfigWorkerProcessRuntime, createConfigWorkerRuntimeController } from '../../src/config-publication';
import { createCatalogSnapshotCompiler } from '../../src/config-worker/snapshot-compiler';
import { runConfigWorkerProcess } from '../../src/config-worker/process-entry';
import { fakeLifecycle, startMessage } from './config-publication-worker-runtime.fixtures';
import { FakeChannel, IDENTITY, ManualScheduler, settle } from './config-worker-process-runtime.fixtures';

for (const failure of ['heartbeat', 'disconnect'] as const) test(`${failure} watchdog exits while lazy catalog loading never settles`, async () => {
  let markCatalogLoading: (() => void) | undefined;
  const catalogLoading = new Promise<void>((resolve) => { markCatalogLoading = resolve; });
  const neverCatalog = new Promise<never>(() => undefined);
  const channel = new FakeChannel();
  const scheduler = new ManualScheduler();
  const lifecycle = fakeLifecycle();
  const controller = createConfigWorkerRuntimeController({
    pid: channel.pid,
    identity: IDENTITY,
    lifecycle: lifecycle.lifecycle,
    compileSnapshot: createCatalogSnapshotCompiler(async () => {
      markCatalogLoading?.();
      return neverCatalog;
    }),
  });
  const runtime = createConfigWorkerProcessRuntime({
    identity: IDENTITY,
    masterPid: 4321,
    heartbeatTimeoutMs: 100,
    shutdownTimeoutMs: 25,
    channel,
    controller,
    scheduler,
  });

  await runtime.start();
  channel.emitMessage({ ...startMessage(), ...IDENTITY });
  await catalogLoading;
  if (failure === 'heartbeat') scheduler.fire(0);
  else channel.emitDisconnect();
  await settle();
  scheduler.fire(1);
  await settle();

  expect(channel.exits).toEqual([1]);
  expect(lifecycle.calls).toEqual([]);
});

test('invalid environment exits without invoking catalog loader', async () => {
  const channel = new FakeChannel();
  let loads = 0;

  await runConfigWorkerProcess({
    env: {},
    channel,
    loadCatalog: async () => {
      loads += 1;
      return new Promise<never>(() => undefined);
    },
  });

  expect(loads).toBe(0);
  expect(channel.exits).toEqual([1]);
});
