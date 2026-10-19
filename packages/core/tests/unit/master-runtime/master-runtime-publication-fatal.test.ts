import { expect, test } from 'bun:test';
import { settle, supervisionFixture } from '../../helpers/master-runtime-supervision';

test('controlled failure during listener startup cannot report started or expose a ready port',async()=>{
  const failures:Error[]=[];
  const harness=supervisionFixture(undefined,{onFailure:error=>{failures.push(error);}});
  harness.setListenerStart(()=>harness.failPublication(new Error('startup fault')));
  await expect(harness.runtime.start()).rejects.toThrow('configuration publication failed');
  expect(harness.runtime.publicPort).toBeNull();
  expect(failures.length).toBeGreaterThan(0);
  await harness.runtime.shutdownAfterStartupFailure();
});

test('publication fatal signal enters runtime fatal shutdown path', async () => {
  const failures: Error[] = [];
  const harness = supervisionFixture((error) => { failures.push(error); });
  await harness.runtime.start();

  harness.failPublication(new Error('fatal publication outcome'));
  await settle();

  expect(failures).toHaveLength(1);
  expect(failures[0]?.message).toContain('configuration publication failed');
  expect(harness.pool.shutdownCount).toBe(1);
  const shutdownError = await harness.runtime.shutdown().catch((error: unknown) => error);
  expect(String(shutdownError)).toContain('configuration publication failed');
});
