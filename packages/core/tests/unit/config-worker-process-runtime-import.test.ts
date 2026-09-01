import { expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('worker process runtime module import is inert', async () => {
  // Given
  const before = {
    disconnect: process.listenerCount('disconnect'),
    message: process.listenerCount('message'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  };

  // When
  await import('../../src/config-publication/worker-process-runtime');

  // Then
  expect({
    disconnect: process.listenerCount('disconnect'),
    message: process.listenerCount('message'),
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM'),
  }).toEqual(before);
});

test('worker entry import is inert even when BUNGEE_ROLE is worker', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-worker-import-'));
  const workerUrl = Bun.pathToFileURL(resolve(import.meta.dir, '../../src/worker.ts')).href;
  const source = `
    const before = {
      disconnect: process.listenerCount('disconnect'),
      message: process.listenerCount('message'),
      SIGINT: process.listenerCount('SIGINT'),
      SIGTERM: process.listenerCount('SIGTERM'),
    };
    const serve = Bun.serve;
    let serveCalls = 0;
    Bun.serve = (...args) => { serveCalls += 1; return serve(...args); };
    await import(${JSON.stringify(workerUrl)});
    console.log(JSON.stringify({
      before,
      after: {
        disconnect: process.listenerCount('disconnect'),
        message: process.listenerCount('message'),
        SIGINT: process.listenerCount('SIGINT'),
        SIGTERM: process.listenerCount('SIGTERM'),
      },
      serveCalls,
    }));
  `;

  try {
    const processResult = Bun.spawn({
      cmd: [process.execPath, '--eval', source],
      cwd: directory,
      env: { ...Bun.env, BUNGEE_ROLE: 'worker' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [exitCode, stdout, entries] = await Promise.all([
      processResult.exited,
      new Response(processResult.stdout).text(),
      readdir(directory),
    ]);
    expect(exitCode).toBe(0);
    const result = JSON.parse(stdout.trim()) as {
      before: Record<string, number>;
      after: Record<string, number>;
      serveCalls: number;
    };
    expect(result.after).toEqual(result.before);
    expect(result.serveCalls).toBe(0);
    expect(entries).toEqual([]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
