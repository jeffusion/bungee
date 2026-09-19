import { afterEach, describe, expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';
import { dispatchProcessRole, ProcessRoleError } from '../../src/main';
import { cleanupProcesses, ProcessRegistry } from '../fixtures/process-cleanup';

const processes = new ProcessRegistry();
afterEach(async () => cleanupProcesses(processes));

// Resolve a real on-PATH bun executable: process.execPath may point at a non-bun runtime.
const bunExecutable = Bun.which('bun') ?? process.execPath;
const coreRoot = fileURLToPath(new URL('../..', import.meta.url));

function deferred() {
  let resolve = (): void => { throw new Error('resolver unavailable'); };
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe('main role dispatch', () => {
  test.each(['worker', 'master'] as const)('awaits only the %s startup path', async (role) => {
    const started = deferred();
    const calls: string[] = [];
    const dispatch = dispatchProcessRole(role, {
      startWorker: () => { calls.push('worker'); return started.promise; },
      startMaster: () => { calls.push('master'); return started.promise; },
    });

    await Promise.resolve();
    expect(calls).toEqual([role]);
    let settled = false;
    void dispatch.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse();

    started.resolve();
    await dispatch;
    expect(settled).toBeTrue();
  });

  test('dispatches the independent ingress role without touching worker or master', async () => {
    const calls: string[] = [];
    await dispatchProcessRole('ingress', {
      startWorker: async () => { calls.push('worker'); },
      startMaster: async () => { calls.push('master'); },
      startIngress: async () => { calls.push('ingress'); },
    });
    expect(calls).toEqual(['ingress']);
  });

  test('rejects every role other than exact worker and master', async () => {
    const dependencies = {
      startWorker: async () => undefined,
      startMaster: async () => undefined,
    };

    for (const role of ['', 'Worker', 'MASTER', 'unknown']) {
      const error = await dispatchProcessRole(role, dependencies).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(ProcessRoleError);
      expect(error).toMatchObject({ code: 'invalid_role', role });
    }
  });

  test('maps an unknown production role to a nonzero process exit', async () => {
    const child = Bun.spawn([bunExecutable, 'src/main.ts', '--bungee-process-identity=90000000-0000-4000-8000-000000000001'], {
      cwd: coreRoot,
      env: { ...process.env, BUNGEE_ROLE: 'unknown' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    processes.registerChild(child);

    expect(await child.exited).toBe(1);
  });

  test('maps production startup failure to a nonzero process exit', async () => {
    const child = Bun.spawn([bunExecutable, 'src/main.ts'], {
      cwd: coreRoot,
      env: { ...process.env, BUNGEE_ROLE: 'master', WORKER_COUNT: '0' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    processes.registerChild(child);

    expect(await child.exited).toBe(1);
  });

  test('defaults an unset role to master startup', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, WORKER_COUNT: '0' };
    delete env.BUNGEE_ROLE;
    const child = Bun.spawn([bunExecutable, 'src/main.ts'], {
      cwd: coreRoot,
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    });
    processes.registerChild(child);

    expect(await child.exited).toBe(1);
  });
});
