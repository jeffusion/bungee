import { expect, test } from 'bun:test';
import { cleanupMasterRuntime } from '../../src/master-runtime/runtime-cleanup';

async function settle(): Promise<void> {
  for (let step = 0; step < 10; step += 1) await Promise.resolve();
}

test('cleanup stops listener then waits publication and repair before clearing admission', async () => {
  const calls: string[] = [];
  let releasePublication = (): void => undefined;
  const publication = new Promise<void>((resolve) => { releasePublication = resolve; });
  let releaseRepair = (): void => undefined;
  const repair = new Promise<void>((resolve) => { releaseRepair = resolve; });
  const cleanup = cleanupMasterRuntime({
    workerCount: 1,
    repository: { getSnapshot() { throw new Error('unused'); }, close() { calls.push('repository.close'); } },
    coordinator: { async recoverAndPublish() { return null; }, async startCurrent() { throw new Error('unused'); } },
    publicationTasks: { enqueue() {}, setFatalHandler() {},
      async stop() { calls.push('publication.wait'); await publication; } },
    admission: { prepare() { throw new Error('unused'); }, snapshot: () => [], clear() { calls.push('admission.clear'); } },
    publicListener: { port: null, start() {}, async stop() { calls.push('listener.stop'); } },
    workerPool: { pids: () => [], owns: () => false, subscribeExit: () => () => undefined,
      async shutdownAll() { calls.push('pool.shutdown'); return []; } },
    instanceLock: { async release() { calls.push('lock.release'); } },
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
