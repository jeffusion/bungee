import { afterEach, expect, test } from 'bun:test';
import {
  cleanupProcesses,
  macProcessIdentityArgs,
  macProcessSnapshotArgs,
  parseLinuxProcessStartToken,
  parseMacProcessIdentityOutput,
  parseMacProcessSnapshotOutput,
  parseWindowsProcessIdentityOutput,
  ProcessRegistry,
  ProcessSurvivorsError,
  processAlive,
  waitForDead,
} from '../fixtures/process-cleanup';
import type { ProcessIdentitySnapshot } from '../fixtures/process-cleanup';

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

test('waitForDead uses the injected alive predicate', async () => {
  const calls: number[] = [];
  const alive = (pid: number): boolean => {
    calls.push(pid);
    return pid === 11 && calls.filter((candidate) => candidate === 11).length < 3;
  };

  await waitForDead([11, 22], 250, alive);
  expect(calls).toEqual([11, 11, 11, 22]);
});

test('keeps cleanup running and reports shutdown and process failures together', async () => {
  let shutdownCalled = false;
  const shutdownError = new Error('shutdown failed');
  const child = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60_000)'], {
    stdout: 'ignore', stderr: 'ignore',
  });
  processes.registerChild(child);

  let cleanupError: unknown;
  try {
    await cleanupProcesses(processes, () => {
      shutdownCalled = true;
      throw shutdownError;
    });
  } catch (error) { cleanupError = error; }
  expect(shutdownCalled).toBeTrue();
  expect(cleanupError).toBeInstanceOf(AggregateError);
  expect((cleanupError as AggregateError).errors).toContain(shutdownError);
  expect(processAlive(child.pid)).toBeFalse();
});

test('retains registrations after a failed cleanup so a second attempt can finish', async () => {
  let alive = true;
  const child = { pid: 8112, exitCode: null, signalCode: null, kill: () => { alive = false; } };
  const registry = new ProcessRegistry({ alive: () => alive });
  registry.registerChild(child);

  await expect(cleanupProcesses(registry, {
    expectGraceful: true,
    shutdown: () => { throw new Error('transient shutdown failure'); },
  })).rejects.toBeInstanceOf(AggregateError);
  expect(registry.registeredPids).toEqual([child.pid]);

  await cleanupProcesses(registry);
  expect(registry.registeredPids).toEqual([]);
});

test('returns timeout survivors instead of silently succeeding', async () => {
  let error: unknown;
  try { await waitForDead([71, 72], 1, () => true); }
  catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ProcessSurvivorsError);
  expect((error as ProcessSurvivorsError).survivors).toEqual([71, 72]);
});

test('parses Linux, Windows, and macOS process identity snapshots', () => {
  expect(parseLinuxProcessStartToken('71 (bun worker) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19')).toBe('19');
  expect(parseWindowsProcessIdentityOutput(JSON.stringify({ ProcessId: 71, ParentProcessId: 7, CreationDate: 'start', ExecutablePath: 'C:\\bun.exe', CommandLine: 'bun worker' }))).toMatchObject({ pid: 71, ppid: 7, startToken: 'start' });
  expect(parseMacProcessIdentityOutput('7 Mon Jan 01 00:00:00 2024 /usr/bin/bun bun worker BUNGEE_TEST_PROCESS_MARKER=fixture BUNGEE_ROLE=worker', 71)).toMatchObject({ pid: 71, ppid: 7, testMarker: 'fixture', roleMarker: 'worker' });
  expect(parseMacProcessSnapshotOutput('71 7 Mon Jan 01 00:00:00 2024 /usr/bin/bun bun worker BUNGEE_TEST_PROCESS_MARKER=fixture BUNGEE_ROLE=worker')).toMatchObject([{ pid: 71, ppid: 7, testMarker: 'fixture', roleMarker: 'worker' }]);
  expect(macProcessIdentityArgs(71)).toEqual(['-Eww', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '71']);
  expect(macProcessSnapshotArgs()).toEqual(['-Eww', '-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=']);
});

test('refuses unknown, reused, or /usr/app-like mismatched identities without signalling', async () => {
  const signals: number[] = [];
  const expected: ProcessIdentitySnapshot = { pid: 8101, ppid: 1, startToken: 'old', executable: '/usr/app/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  const actual: ProcessIdentitySnapshot = { ...expected, startToken: 'new', executable: '/usr/bin/bun' };
  const registry = new ProcessRegistry({
    captureIdentity: async () => actual,
    alive: () => true,
    signal: (pid) => signals.push(pid),
  });
  registry.registerPid(expected.pid, expected, { role: 'worker' });
  let error: unknown;
  try { await cleanupProcesses(registry); } catch (caught) { error = caught; }
  expect(signals).toEqual([]);
  expect(error).toBeInstanceOf(AggregateError);
});

test('uses an exact child handle and preserves a graceful leak before emergency teardown', async () => {
  let alive = true;
  let killed = 0;
  const child = { pid: 8102, exitCode: null, signalCode: null, kill: () => { killed += 1; alive = false; } };
  const registry = new ProcessRegistry({ alive: () => alive });
  registry.registerChild(child);
  let error: unknown;
  try { await cleanupProcesses(registry, { expectGraceful: true, shutdown: () => undefined }); }
  catch (caught) { error = caught; }
  expect(killed).toBe(1);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.some((entry) => String(entry).includes('production graceful shutdown leak'))).toBeTrue();
});

test('does not duplicate an adopted ingress owner', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8103, ppid: 1, startToken: 'start', executable: '/usr/bin/bun', commandLine: 'bun ingress', testMarker: 'cleanup-test' };
  const first = new ProcessRegistry({ alive: () => false });
  const second = new ProcessRegistry({ alive: () => false });
  expect(first.registerAdoptedIngress(identity.pid, 3012, identity)).toBe(identity.pid);
  expect(second.registerAdoptedIngress(identity.pid, 3012, identity)).toBeUndefined();
  expect(first.ownsPid(identity.pid)).toBeTrue();
  expect(second.ownsPid(identity.pid)).toBeFalse();
  await cleanupProcesses(first);
  await cleanupProcesses(second);
});

test('does not claim the same PID through a different port', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8104, ppid: 1, startToken: 'start', executable: '/usr/bin/bun', commandLine: 'bun ingress', testMarker: 'cleanup-test' };
  const first = new ProcessRegistry({ alive: () => false });
  const second = new ProcessRegistry({ alive: () => false });
  expect(first.registerAdoptedIngress(identity.pid, 3013, identity)).toBe(identity.pid);
  expect(second.registerAdoptedIngress(identity.pid, 3014, identity)).toBeUndefined();
  await cleanupProcesses(first);
  await cleanupProcesses(second);
});

test('returns undefined for invalid non-child registration claims', () => {
  const registry = new ProcessRegistry();
  const identity: ProcessIdentitySnapshot = { pid: 8106, ppid: 1, startToken: 'start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  expect(registry.registerPid(undefined, identity, { role: 'worker' })).toBeUndefined();
  expect(registry.registerPid(identity.pid, { ...identity, pid: 8107 }, { role: 'worker' })).toBeUndefined();
});

test('only releases an adopted owner with the same exact identity proof', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8105, ppid: 1, startToken: 'start', executable: '/usr/bin/bun', commandLine: 'bun ingress', testMarker: 'cleanup-test' };
  const first = new ProcessRegistry({ alive: () => false });
  const second = new ProcessRegistry({ alive: () => false });
  first.registerAdoptedIngress(identity.pid, 3015, identity);
  expect(first.release({ ...identity, startToken: 'reused' })).toBeFalse();
  expect(second.registerAdoptedIngress(identity.pid, 3016, identity)).toBeUndefined();
  expect(first.release(identity)).toBeTrue();
  expect(second.registerAdoptedIngress(identity.pid, 3016, identity)).toBe(identity.pid);
  await cleanupProcesses(first);
  await cleanupProcesses(second);
});

test('aggregates probe errors and continues from TERM to KILL without signalling unknown identity', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8107, ppid: 1, startToken: 'start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  const signals: string[] = [];
  let captures = 0;
  const registry = new ProcessRegistry({
    captureIdentity: async () => {
      captures += 1;
      if (captures === 1) throw new Error('probe failed');
      return identity;
    },
    alive: () => true,
    signal: (_pid, signal) => { signals.push(signal); },
  });
  registry.registerPid(identity.pid, identity, { role: 'worker' });
  let error: unknown;
  try { await cleanupProcesses(registry); } catch (caught) { error = caught; }
  expect(signals).toEqual(['SIGKILL']);
  expect(error).toBeInstanceOf(AggregateError);
  expect((error as AggregateError).errors.some((entry) => String(entry).includes('probe failed'))).toBeTrue();
  expect(registry.release(identity)).toBeTrue();
});

test('Windows identity uses the real CIM fields without role or test-marker assumptions', async () => {
  const expected: ProcessIdentitySnapshot = { pid: 8108, ppid: 100, startToken: 'CreationDate', executable: 'C:\\Bun.exe', commandLine: 'bun worker' };
  let alive = true;
  const signals: string[] = [];
  const registry = new ProcessRegistry({ platform: 'win32', alive: () => alive,
    captureIdentity: async () => expected, signal: (_pid, signal) => { signals.push(signal); alive = false; } });
  registry.registerPid(expected.pid, expected, { role: 'worker' });
  await cleanupProcesses(registry);
  expect(signals).toEqual(['SIGTERM']);

  for (const [pid, field] of [[8109, 'startToken'], [8110, 'executable'], [8111, 'commandLine']] as const) {
    const proof = { ...expected, pid };
    const mismatch = { ...proof, ...(field === 'startToken' ? { startToken: 'reused' } : {}),
      ...(field === 'executable' ? { executable: 'C:\\other.exe' } : {}),
      ...(field === 'commandLine' ? { commandLine: 'bun other' } : {}) };
    const refused: string[] = [];
    const mismatchRegistry = new ProcessRegistry({ platform: 'win32', alive: () => true,
      captureIdentity: async () => mismatch, signal: (_pid, signal) => { refused.push(signal); } });
    mismatchRegistry.registerPid(pid, proof, { role: 'worker' });
    await expect(cleanupProcesses(mismatchRegistry)).rejects.toBeInstanceOf(AggregateError);
    expect(refused).toEqual([]);
  }
});
