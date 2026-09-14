import { afterEach, expect, test } from 'bun:test';
import { cleanupProcesses, ProcessRegistry, processAlive } from '../fixtures/process-cleanup';

const processes = new ProcessRegistry();
afterEach(async () => cleanupProcesses(processes));

test('cleans only registered processes and is idempotent', async () => {
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60_000)'], {
    stdout: 'ignore', stderr: 'ignore',
  });
  processes.registerChild(child);
  expect(processAlive(child.pid)).toBeTrue();

  await cleanupProcesses(processes);
  expect(processAlive(child.pid)).toBeFalse();
  await cleanupProcesses(processes);
});
