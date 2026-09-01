import { describe, expect, test } from 'bun:test';
import { dispatchProcessRole, ProcessRoleError } from '../../src/main';

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
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, BUNGEE_ROLE: 'unknown' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await child.exited).toBe(1);
  });

  test('maps production startup failure to a nonzero process exit', async () => {
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, BUNGEE_ROLE: 'master', WORKER_COUNT: '0' },
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await child.exited).toBe(1);
  });

  test('defaults an unset role to master startup', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, WORKER_COUNT: '0' };
    delete env.BUNGEE_ROLE;
    const child = Bun.spawn([process.execPath, 'src/main.ts'], {
      cwd: new URL('../..', import.meta.url).pathname,
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    });

    expect(await child.exited).toBe(1);
  });
});
