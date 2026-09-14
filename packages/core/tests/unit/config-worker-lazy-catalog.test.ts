import { expect, test } from 'bun:test';
import { createConfigWorkerRuntimeController } from '../../src/config-publication';
import { fakeLifecycle, startMessage } from './config-publication-worker-runtime.fixtures';

test('lazy runtime compilation is deferred until the first worker command', async () => {
  let loads = 0;
  const controller = createConfigWorkerRuntimeController({
    pid: 1234,
    identity: {
      master_generation: '50000000-0000-4000-8000-000000000001',
      worker_instance_id: '60000000-0000-4000-8000-000000000001',
      worker_slot: 0,
    },
    lifecycle: fakeLifecycle().lifecycle,
    compileSnapshot: async () => {
      loads += 1;
      throw new Error('lazy compiler failure');
    },
  });

  expect(loads).toBe(0);
  const result = await controller.apply({ ...startMessage(), worker_slot: 0 });
  expect(loads).toBe(1);
  expect(result.ok).toBeTrue();
  if (result.ok) expect(result.message.status).toBe('config-apply-failed');
});
