import { expect, test } from 'bun:test';
import { cleanupAfterStartupFailure, closeForNormalShutdown } from '../../src/master-runtime/runtime-cleanup';
import type { MasterIngressStartupFailureDisposition } from '../../src/ingress/master-controller';

async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

const SAFE_EMPTY: MasterIngressStartupFailureDisposition = Object.freeze({
  kind: 'shutdown_safe_empty', origin: 'spawned',
  evidence: Object.freeze({ registry: Object.freeze({ active: null, prepared: null, retired: Object.freeze([]) }),
    statusRefreshed: true, pendingAdmission: false, uncertainAdmission: false, pendingRetiredRelease: false }),
});

test('cleanup stops listener then waits publication and repair before clearing admission', async () => {
  const calls: string[] = [];
  let releasePublication = (): void => undefined;
  const publication = new Promise<void>((resolve) => { releasePublication = resolve; });
  let releaseRepair = (): void => undefined;
  const repair = new Promise<void>((resolve) => { releaseRepair = resolve; });
  const cleanup = closeForNormalShutdown({
    workerCount: 1,
    expectedPluginCatalogHash: 'sha256:' + 'b'.repeat(64),
    repository: { getSnapshot() { throw new Error('unused'); }, close() { calls.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { enqueue() {}, async enqueueRecovery(task) { return task(); }, setFatalHandler() {},
      async stop() { calls.push('publication.wait'); await publication; } },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() { throw new Error('unused'); }, snapshot: () => [], clear() { calls.push('admission.clear'); } },
    publicListener: { port: null, start() {}, async stop() { calls.push('listener.stop'); } },
    workerPool: { pids: () => [], owns: () => false, subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined, disconnectAll: () => undefined, markCommitted: () => undefined,
      async shutdownAll() { calls.push('pool.shutdown'); return []; } },
    instanceLock: { async release() { calls.push('lock.release'); } },
    onWorkerUnavailable() {},
  }, null, repair);
  await settle();
  expect(calls).toEqual(['listener.stop', 'publication.wait']);
  releasePublication();
  await settle();
  expect(calls).toEqual(['listener.stop', 'publication.wait']);
  releaseRepair();
  expect(await cleanup).toEqual([]);
  expect(calls).toEqual(['listener.stop', 'publication.wait', 'admission.clear', 'pool.shutdown',
    'repository.close', 'lock.release']);
});

test('requires both listeners to close before releasing the instance lock', async () => {
  const calls: string[] = [];
  const errors = await closeForNormalShutdown({
    workerCount: 0, expectedPluginCatalogHash: 'sha256:' + 'b'.repeat(64),
    repository: { getSnapshot() { throw new Error('unused'); }, close() { calls.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { enqueue() {}, async enqueueRecovery(task) { return task(); }, setFatalHandler() {}, async stop() {} },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot: () => [], clear() {} },
    publicListener: { port: 8089, stopAccepting() { calls.push('public.stopAccepting'); }, start() {}, async stop() { calls.push('public.stop'); } },
    controlListener: { port: 3011, stopAccepting() { calls.push('control.stopAccepting'); }, start() {}, async stop() { calls.push('control.stop'); throw new Error('control stop failed'); } },
    workerPool: { pids: () => [], owns: () => false, subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined, disconnectAll: () => undefined, markCommitted: () => undefined,
      async shutdownAll() { calls.push('pool.shutdown'); return []; } },
    instanceLock: { async release() { calls.push('lock.release'); } }, onWorkerUnavailable() {},
  }, null, Promise.resolve());
  expect(errors.length).toBeGreaterThan(0);
  expect(calls).not.toContain('lock.release');
  expect(calls.indexOf('control.stop')).toBeLessThan(calls.indexOf('pool.shutdown'));
});

test('closes private control before releasing the lock on success', async () => {
  const calls: string[] = [];
  const errors = await closeForNormalShutdown({
    workerCount: 0, expectedPluginCatalogHash: 'sha256:' + 'b'.repeat(64),
    repository: { getSnapshot() { throw new Error('unused'); }, close() { calls.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { enqueue() {}, async enqueueRecovery(task) { return task(); }, setFatalHandler() {}, async stop() {} },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot: () => [], clear() {} },
    publicListener: { port: 8089, start() {}, async stop() { calls.push('public.stop'); } },
    controlListener: { port: 3011, start() {}, async stop() { calls.push('control.stop'); } },
    workerPool: { pids: () => [], owns: () => false, subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined, disconnectAll: () => undefined, markCommitted: () => undefined,
      async shutdownAll() { return []; } },
    instanceLock: { async release() { calls.push('lock.release'); } }, onWorkerUnavailable() {},
  }, null, Promise.resolve());
  expect(errors).toEqual([]);
  expect(calls.indexOf('control.stop')).toBeLessThan(calls.indexOf('lock.release'));
});

test('runs beforeCleanup for startup cleanup and retains the lock when it fails', async () => {
  const calls: string[] = [];
  const errors = await cleanupAfterStartupFailure({
    workerCount: 1,
    expectedPluginCatalogHash: 'sha256:' + 'b'.repeat(64),
    repository: { getSnapshot() { throw new Error('unused'); }, close() { calls.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { async stop() { calls.push('publication.stop'); } },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot: () => [], clear() { calls.push('admission.clear'); } },
    publicListener: { port: null, start() {}, async stop() { calls.push('listener.stop'); } },
    workerPool: {
      pids: () => [], owns: () => false, subscribeExit: () => () => undefined, subscribeUnavailable: () => () => undefined,
      markCommitted() {}, disconnectAll() { calls.push('pool.disconnect'); }, async shutdownAll() { calls.push('pool.shutdown'); return []; },
    },
    instanceLock: { async release() { calls.push('lock.release'); } },
    onWorkerUnavailable() {},
    ancillary: { beforeCleanup() { calls.push('beforeCleanup'); throw new Error('background stop failed'); }, cleanupAfterStartupFailure() {} },
  } as unknown as import('../../src/master-runtime/runtime-contracts').MasterRuntimeOptions, null, Promise.resolve());
  expect(errors.map(String)).toContain('Error: background stop failed');
  expect(calls).toEqual(['listener.stop', 'beforeCleanup', 'publication.stop', 'pool.disconnect', 'repository.close']);
  expect(calls).not.toContain('lock.release');
});

test('normal shutdown never closes ingress without exact worker exit proof', async () => {
  for (const mode of ['missing', 'mismatch', 'throw'] as const) {
    let ingressClose = 0;
    let lockReleased = false;
    const process = { pid: 41 };
    const errors = await closeForNormalShutdown({
      workerCount: 1,
      repository: { getSnapshot() { throw new Error('unused'); }, close() {} },
      coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
      publicationTasks: { async stop() {} },
      admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot() { return []; }, clear() {} },
      publicListener: { port: null, start() {}, async stop() {} },
      workerPool: {
        pids() { if (mode === 'throw') throw new Error('pid snapshot failed'); return [41]; },
        owns() { return true; }, subscribeExit() { return () => undefined; }, subscribeUnavailable() { return () => undefined; },
        markCommitted() {}, disconnectAll() {},
        async shutdownAll() {
          if (mode === 'throw') throw new Error('shutdown failed');
          return mode === 'missing' ? [] : [{ process: { pid: 42 }, exitEvidence: { exited: true, pid: 42 } }];
        },
      },
      ancillary: { closeForNormalShutdown() { ingressClose += 1; } },
      instanceLock: { async release() { lockReleased = true; } }, onWorkerUnavailable() {},
    } as unknown as import('../../src/master-runtime/runtime-contracts').MasterRuntimeOptions, null, Promise.resolve());
    expect(ingressClose).toBe(0);
    expect(lockReleased).toBeFalse();
    expect(errors.map(String)).toContain('MasterRuntimeError: worker exits were not confirmed; instance lock retained');
  }
});

test('safe-empty startup cleanup stays pending until worker shutdown settles', async () => {
  let releaseWorkers = (): void => undefined;
  const workersSettled = new Promise<void>((resolve) => { releaseWorkers = resolve; });
  let lockReleased = false;
  const cleanup = cleanupAfterStartupFailure({
    workerCount: 0,
    repository: { getSnapshot() { throw new Error('unused'); }, close() {} },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { async stop() {} },
    admission: { prepare() { throw new Error('unused'); }, adoptCommitted() {}, snapshot() { return []; }, clear() {} },
    publicListener: { port: null, start() {}, async stop() {} },
    workerPool: { pids() { return []; }, owns() { return true; }, subscribeExit() { return () => undefined; }, subscribeUnavailable() { return () => undefined; },
      markCommitted() {}, disconnectAll() {}, async shutdownAll() { return []; } },
    cleanupWorkersAfterStartupFailure: async (disposition: MasterIngressStartupFailureDisposition | undefined) => {
      expect(disposition).toBe(SAFE_EMPTY); await workersSettled;
    },
    ancillary: { cleanupAfterStartupFailure() { return SAFE_EMPTY; } },
    instanceLock: { async release() { lockReleased = true; } }, onWorkerUnavailable() {},
  } as unknown as import('../../src/master-runtime/runtime-contracts').MasterRuntimeOptions, null, Promise.resolve());
  await settle();
  expect(lockReleased).toBeFalse();
  releaseWorkers();
  expect(await cleanup).toEqual([]);
  expect(lockReleased).toBeTrue();
});
