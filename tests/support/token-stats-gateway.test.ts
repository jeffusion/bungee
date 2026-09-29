import { expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  stopOwnedMaster,
  type OwnedMaster,
} from './token-stats-gateway';

const NO_SUCH_PID = 2_147_000_000;

function ownedChild(script: string): Promise<OwnedMaster> {
  const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const output: string[] = [];
  child.stdout?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => output.push(chunk.toString('utf8')));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('fault-injection child did not initialize'));
    }, 2_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      if (chunk.toString('utf8').includes('READY')) {
        clearTimeout(timer);
        resolve(makeOwnedMaster(child, output));
      }
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('close', (code) => {
      if (code !== null) {
        clearTimeout(timer);
        reject(new Error(`fault-injection child exited during initialization (${code})`));
      }
    });
  });
}

function makeOwnedMaster(child: ChildProcess, output: string[]): OwnedMaster {
  return {
    child,
    output,
    token: 'not-used',
    workers: new Map([
      ['00000000-0000-4000-8000-000000000001', { pid: NO_SUCH_PID, workerInstanceId: '00000000-0000-4000-8000-000000000001' }],
      ['00000000-0000-4000-8000-000000000002', { pid: NO_SUCH_PID - 1, workerInstanceId: '00000000-0000-4000-8000-000000000002' }],
    ]),
    workerInventoryComplete: true,
  };
}

test('shutdown rejects nonzero SIGTERM exit and refuses to treat a bounded timeout as graceful', async () => {
  const failedExit = await ownedChild(`
    process.on('SIGTERM', () => process.exit(1));
    console.log('READY');
    setInterval(() => {}, 1000);
  `);
  const nonzeroFailure = await stopFailure(failedExit, { graceTimeoutMs: 500, forceTimeoutMs: 500 });
  expect(nonzeroFailure).toMatchObject({ name: 'OwnedMasterShutdownError', workersVerifiedExited: true });
  expect(nonzeroFailure.message).toContain('exitCode=1');
  expect(failedExit.child.exitCode).toBe(1);
  expect(failedExit.child.signalCode).toBeNull();

  const delayedExit = await ownedChild(`
    process.on('SIGTERM', () => setTimeout(() => process.exit(0), 2000));
    console.log('READY');
    setInterval(() => {}, 1000);
  `);
  const timeoutFailure = await stopFailure(delayedExit, { graceTimeoutMs: 30, forceTimeoutMs: 500 });
  expect(timeoutFailure).toMatchObject({ name: 'OwnedMasterShutdownError', workersVerifiedExited: true });
  expect(timeoutFailure.message).toContain('exceeded graceful shutdown deadline');
  expect(delayedExit.child.exitCode).toBeNull();
  expect(delayedExit.child.signalCode).toBe('SIGKILL');
});

async function stopFailure(master: OwnedMaster, options: { graceTimeoutMs: number; forceTimeoutMs: number }): Promise<Error> {
  try {
    await stopOwnedMaster(master, options);
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error('shutdown helper rejected with a non-Error value');
  }
  throw new Error('shutdown helper incorrectly reported success');
}
