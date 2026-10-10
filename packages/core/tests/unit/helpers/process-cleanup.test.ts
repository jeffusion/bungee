import { expect, test } from 'bun:test';
import { cleanupProcesses, ProcessRegistry } from '../../helpers/process-cleanup';

test('a Bun child without signalCode is terminated and its exit is awaited', async () => {
  const registry = new ProcessRegistry(), signals: string[] = [];
  let resolve!: (code: number) => void;
  const child = { pid: 1, exitCode: null as number | null, exited: new Promise<number>(done => resolve = done),
    kill(signal: string) { signals.push(signal); queueMicrotask(() => { child.exitCode = 0; resolve(0); }); } };
  registry.registerChild(child); await cleanupProcesses(registry);
  expect(signals).toEqual(['SIGTERM']);expect(child.exitCode).toBe(0);
});
test('confirmed exit avoids another signal and a Node child waits for close', async () => {
  const registry = new ProcessRegistry(), signals: string[] = [];
  registry.registerChild({ exitCode: 0, kill: () => { throw new Error('must not signal'); } });
  const child = { exitCode: null as number | null, signalCode: null as string | null,
    once(_event: string, callback: () => void) { queueMicrotask(() => { child.signalCode = 'SIGTERM'; callback(); }); },
    kill(signal: string) { signals.push(signal); } };
  registry.registerChild(child);await cleanupProcesses(registry);expect(signals).toEqual(['SIGTERM']);
});
test('timeout forces only the registered child, reports failure and still cleans the next child', async () => {
  const registry = new ProcessRegistry(), signals: string[] = [];
  let resolve!: (code: number) => void;
  const first = { exitCode: null as number | null, exited: new Promise<number>(done => resolve = done),
    kill(signal: string) { signals.push(signal); if(signal === 'SIGKILL') { first.exitCode = 1; resolve(1); } } };
  const second = { exitCode: null as number | null, exited: Promise.resolve(0), kill() { signals.push('second'); second.exitCode = 0; } };
  registry.registerChild(first);registry.registerChild(second);
  await expect(cleanupProcesses(registry, 10)).rejects.toThrow('Registered process cleanup failed');
  expect(signals).toEqual(['SIGTERM','SIGKILL','second']);expect(first.exitCode).toBe(1);expect(second.exitCode).toBe(0);
});
