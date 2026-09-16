import { afterEach, expect, test } from 'bun:test';
import {
  cleanupProcesses,
  captureLinuxProcessIdentity,
  captureMacProcessIdentity,
  macProcessEnvironmentArgs,
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
  expect(parseMacProcessIdentityOutput('7 Mon Jan 01 00:00:00 2024 /usr/bin/bun bun worker', 71)).toMatchObject({ pid: 71, ppid: 7 });
  expect(parseMacProcessSnapshotOutput('71 7 Mon Jan 01 00:00:00 2024 /usr/bin/bun bun worker')).toMatchObject([{ pid: 71, ppid: 7 }]);
  expect(macProcessIdentityArgs(71)).toEqual(['-ww', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', '71']);
  expect(macProcessSnapshotArgs()).toEqual(['-ww', '-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=']);
  expect(macProcessEnvironmentArgs(71)).toEqual(['-Eww', '-p', '71', '-o', 'args=']);
});

test('returns null when Linux direct identity samples mix executables', async () => {
  const stat = '71 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19';
  let sample = 0;
  const readFile = async (path: string): Promise<string> => {
    if (path.endsWith('/stat')) return stat;
    if (path.endsWith('/cmdline')) return 'bun\0worker\0';
    if (path.endsWith('/environ')) return 'BUNGEE_ROLE=worker\0BUNGEE_TEST_PROCESS_MARKER=fixture\0';
    throw new Error(`unexpected path ${path}`);
  };
  const readlink = async (): Promise<string> => {
    sample += 1;
    return sample === 1 ? '/usr/bin/bun' : '/usr/local/bin/bun';
  };
  await expect(captureLinuxProcessIdentity(71, { readFile: readFile as never, readlink: readlink as never })).resolves.toBeNull();
});

test('returns null when Linux direct identity samples mix pre-exec and target markers', async () => {
  const stat = '72 (bun) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19';
  let sample = 0;
  const readFile = async (path: string): Promise<string> => {
    if (path.endsWith('/stat')) return stat;
    if (path.endsWith('/cmdline')) return 'bun\0target\0';
    if (path.endsWith('/environ')) return sample === 1 ? 'BUNGEE_ROLE=preexec\0' : 'BUNGEE_ROLE=target\0';
    throw new Error(`unexpected path ${path}`);
  };
  const readlink = async (): Promise<string> => { sample += 1; return '/usr/bin/bun'; };
  const readers = { readFile: readFile as never, readlink: readlink as never };
  await expect(captureLinuxProcessIdentity(72, readers)).resolves.toBeNull();
  sample = 0;
  const stableReadFile = async (path: string): Promise<string> => {
    if (path.endsWith('/environ')) return 'BUNGEE_ROLE=target\0';
    return readFile(path);
  };
  await expect(captureLinuxProcessIdentity(72, { readFile: stableReadFile as never, readlink: readlink as never }))
    .resolves.toMatchObject({ commandLine: 'bun target', roleMarker: 'target', startToken: '19' });
});

test.each([
  ['exit=1 with empty output', Object.assign(new Error('missing'), { code: 1, stdout: '', stderr: '' }), false],
  ['exit=1 without output fields', Object.assign(new Error('missing'), { code: 1 }), true],
  ['permission error', Object.assign(new Error('permission denied'), { code: 1, stdout: '', stderr: 'ps: permission denied' }), true],
  ['timeout', Object.assign(new Error('timed out'), { code: 'ETIMEDOUT', stdout: '', stderr: '' }), true],
  ['tool missing', Object.assign(new Error('missing ps'), { code: 'ENOENT', stdout: '', stderr: '' }), true],
  ['parse error', undefined, true],
] as const)('Darwin single-PID ps probe is fail-closed for %s', async (_label, error, rejects) => {
  const execute = async () => {
    if (error === undefined) return { stdout: 'not a process identity', stderr: '' };
    throw error;
  };
  const result = captureMacProcessIdentity(71, execute as never);
  if (rejects) await expect(result).rejects.toBeDefined();
  else await expect(result).resolves.toBeNull();
});

test('cleanup escalates an immediate client-cancel survivor using exact identities and releases ports', async () => {
  const root: ProcessIdentitySnapshot = { pid: 8210, ppid: 1, startToken: 'root', executable: '/usr/bin/bun', commandLine: 'bun --root', testMarker: 'cleanup-test' };
  const worker: ProcessIdentitySnapshot = { pid: 8211, ppid: root.pid, startToken: 'worker', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  const ingress: ProcessIdentitySnapshot = { pid: 8212, ppid: root.pid, startToken: 'ingress', executable: '/usr/bin/bun', commandLine: 'bun ingress', testMarker: 'cleanup-test' };
  const identities = new Map([root, worker, ingress].map((identity) => [identity.pid, identity]));
  const alive = new Set(identities.keys());
  const signals: string[] = [];
  const registry = new ProcessRegistry({
    alive: (pid) => alive.has(pid), captureIdentity: async (pid) => identities.get(pid) ?? null,
    signal: (pid, signal) => { signals.push(`${pid}:${signal}`); if (signal === 'SIGKILL') alive.delete(pid); },
  });
  const handle = { pid: root.pid, exitCode: null, signalCode: null, kill: (signal?: NodeJS.Signals) => {
    signals.push(`${root.pid}:${signal ?? 'terminate'}`); if (signal === 'SIGKILL') alive.delete(root.pid);
  } };
  registry.registerChild(handle, root);
  registry.registerPid(worker.pid, worker, { role: 'worker' });
  registry.registerAdoptedIngress(ingress.pid, 8213, ingress);

  await cleanupProcesses(registry, { expectGraceful: false });
  await cleanupProcesses(registry, { expectGraceful: false });
  expect(signals.filter((signal) => signal.endsWith(':SIGTERM'))).toHaveLength(3);
  expect(signals.filter((signal) => signal.endsWith(':SIGKILL'))).toHaveLength(3);
  expect(alive.size).toBe(0);
  expect(registry.registeredPids).toEqual([]);
  const replacement = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(replacement.registerAdoptedIngress(ingress.pid, 8213, ingress)).toBe(ingress.pid);
  await cleanupProcesses(replacement);
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
  await cleanupProcesses(registry);
  expect(signals).toEqual([]);
  expect(registry.registeredPids).toEqual([]);
});

test('signals only a saved child when the root handle already exited', async () => {
  const root: ProcessIdentitySnapshot = { pid: 8301, ppid: 1, startToken: 'root', executable: '/usr/bin/bun', commandLine: 'bun root', testMarker: 'cleanup-test' };
  const child: ProcessIdentitySnapshot = { pid: 8302, ppid: root.pid, startToken: 'child', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  const alive = new Set([child.pid]);
  const signals: string[] = [];
  const registry = new ProcessRegistry({
    alive: (pid) => alive.has(pid), captureIdentity: async (pid) => pid === child.pid ? child : root,
    signal: (pid, signal) => { signals.push(`${pid}:${signal}`); if (signal === 'SIGKILL') alive.delete(pid); },
  });
  registry.registerChild({ pid: root.pid, exitCode: 0, signalCode: null }, root);
  registry.registerPid(child.pid, child, { role: 'worker' });

  await cleanupProcesses(registry);
  expect(signals).toEqual([`${child.pid}:SIGTERM`, `${child.pid}:SIGKILL`]);
  expect(registry.registeredPids).toEqual([]);
});

test('fresh OS identity wins over stale root handle exit evidence', async () => {
  const root: ProcessIdentitySnapshot = { pid: 8303, ppid: 1, startToken: 'root', executable: '/usr/bin/bun', commandLine: 'bun root', testMarker: 'cleanup-test' };
  let probes = 0;
  const signals: string[] = [];
  const registry = new ProcessRegistry({
    alive: () => { probes += 1; return true; }, captureIdentity: async () => { probes += 1; return { ...root, startToken: 'reused' }; },
    signal: (_pid, signal) => { signals.push(signal); },
  });
  registry.registerChild({ pid: root.pid, exitCode: 0, signalCode: null }, root);

  await cleanupProcesses(registry);
  expect(probes).toBeGreaterThan(0);
  expect(signals).toEqual([]);
});

test('fresh exact identity remains signalable despite terminal handle hints', async () => {
  const root: ProcessIdentitySnapshot = { pid: 8_306, ppid: 1, startToken: 'root', executable: '/bun', commandLine: 'bun root' };
  const live = new Set([root.pid]);
  const signals: string[] = [];
  const handle = { pid: root.pid, exitCode: 1, signalCode: 'SIGTERM' as string | null };
  const registry = new ProcessRegistry({
    alive: (pid) => live.has(pid), captureIdentity: async () => root,
    signal: (pid, signal) => { signals.push(signal); handle.signalCode = signal; if (signal === 'SIGKILL') live.delete(pid); },
    requireTestMarker: false,
  });
  registry.registerChild(handle, root);
  await cleanupProcesses(registry);
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(registry.registeredPids).toEqual([]);
});

test('unknown liveness preserves an exact registration until absence is proven', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8_307, ppid: 1, startToken: 'unknown', executable: '/bun', commandLine: 'bun worker' };
  let liveness: 'unknown' | 'absent' = 'unknown';
  const signals: string[] = [];
  const registry = new ProcessRegistry({
    liveness: () => liveness, captureIdentity: async () => identity,
    signal: (_pid, signal) => signals.push(signal), requireTestMarker: false,
  });
  expect(registry.registerPid(identity.pid, identity, { role: 'worker' })).toBe(identity.pid);
  await expect(cleanupProcesses(registry)).rejects.toBeInstanceOf(AggregateError);
  expect(signals).toEqual([]);
  expect(registry.ownsPid(identity.pid)).toBeTrue();
  liveness = 'absent';
  await cleanupProcesses(registry);
  expect(registry.ownsPid(identity.pid)).toBeFalse();
});

test('releases only the exact process handle and permits the reused PID to claim ownership', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8_304, ppid: 1, startToken: 'old', executable: '/bun', commandLine: 'bun root' };
  const firstHandle = { pid: identity.pid, exitCode: null, signalCode: null };
  const otherHandle = { pid: identity.pid, exitCode: null, signalCode: null };
  const registry = new ProcessRegistry({ alive: () => true, requireTestMarker: false });
  registry.registerChild(firstHandle, identity);
  expect(registry.releaseHandle(otherHandle)).toBeFalse();
  expect(registry.ownsPid(identity.pid)).toBeTrue();
  expect(registry.releaseHandle(firstHandle)).toBeTrue();
  expect(registry.ownsPid(identity.pid)).toBeFalse();
  const replacement = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(replacement.registerPid(identity.pid, { ...identity, startToken: 'new' }, { role: 'worker' })).toBe(identity.pid);
  await cleanupProcesses(replacement);
});

test('os absence confirms the exact root handle without probing or signalling its reused PID', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8_305, ppid: 1, startToken: 'old', executable: '/bun', commandLine: 'bun root' };
  let probes = 0;
  const signals: string[] = [];
  const handle = { pid: identity.pid, exitCode: null, signalCode: null };
  const registry = new ProcessRegistry({
    alive: () => { probes += 1; return true; },
    signal: (_pid, signal) => { signals.push(signal); },
    requireTestMarker: false,
  });
  registry.registerChild(handle, identity);
  expect(registry.confirmHandleClosed(handle)).toBeTrue();
  await cleanupProcesses(registry);
  expect(probes).toBe(0);
  expect(signals).toEqual([]);
  const replacement = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(replacement.registerPid(identity.pid, { ...identity, startToken: 'new' }, { role: 'worker' })).toBe(identity.pid);
  await cleanupProcesses(replacement);
});

test('releases a mismatched PID owner but retains an unknown owner', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8304, ppid: 1, startToken: 'expected', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'cleanup-test' };
  const mismatch = new ProcessRegistry({ alive: () => true, captureIdentity: async () => ({ ...identity, startToken: 'reused' }) });
  mismatch.registerAdoptedIngress(identity.pid, 8305, identity);
  await cleanupProcesses(mismatch);
  expect(mismatch.registeredPids).toEqual([]);
  const replacement = new ProcessRegistry({ alive: () => false });
  expect(replacement.registerAdoptedIngress(identity.pid, 8305, identity)).toBe(identity.pid);
  await cleanupProcesses(replacement);

  const unknown = new ProcessRegistry({ alive: () => true, captureIdentity: async () => null });
  unknown.registerAdoptedIngress(identity.pid, 8305, identity);
  await expect(cleanupProcesses(unknown)).rejects.toBeInstanceOf(AggregateError);
  expect(unknown.registeredPids).toEqual([identity.pid]);
  expect(unknown.release(identity)).toBeTrue();
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

test('aggregates probe errors and keeps an unknown identity non-signalable', async () => {
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
  expect(signals).toEqual([]);
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
    await cleanupProcesses(mismatchRegistry);
    expect(refused).toEqual([]);
  }
});

test('attaches bounded fixed cleanup evidence for signal errors, unknown identities, and survivors', async () => {
  const identity = (pid: number): ProcessIdentitySnapshot => ({ pid, ppid: 1, startToken: `start-${pid}`, executable: '/bun', commandLine: 'bun worker' });
  const evidenceOf = (error: unknown): readonly Record<string, unknown>[] => {
    const aggregate = error as AggregateError & { readonly process_cleanup_evidence: readonly Record<string, unknown>[] };
    return aggregate.process_cleanup_evidence;
  };

  let alive = true;
  const signalErrorIdentity = identity(8_401);
  const signalErrorRegistry = new ProcessRegistry({ requireTestMarker: false, alive: () => alive,
    captureIdentity: async () => signalErrorIdentity,
    signal: (_pid, signal) => { if (signal === 'SIGTERM') throw Object.assign(new Error('raw secret'), { code: 'ESRCH' }); alive = false; } });
  signalErrorRegistry.registerPid(signalErrorIdentity.pid, signalErrorIdentity, { role: 'worker' });
  let signalError: unknown;
  try { await cleanupProcesses(signalErrorRegistry); } catch (error) { signalError = error; }
  expect(evidenceOf(signalError).some((event) => event.phase === 'sigterm_signal' && event.outcome === 'signal_error'
    && event.signal === 'SIGTERM' && event.error_code === 'ESRCH')).toBeTrue();
  signalErrorRegistry.release(signalErrorIdentity);

  const unknownIdentity = identity(8_402);
  const unknownRegistry = new ProcessRegistry({ requireTestMarker: false, alive: () => true, captureIdentity: async () => null });
  unknownRegistry.registerPid(unknownIdentity.pid, unknownIdentity, { role: 'worker' });
  let unknownError: unknown;
  try { await cleanupProcesses(unknownRegistry); } catch (error) { unknownError = error; }
  expect(evidenceOf(unknownError).some((event) => event.phase === 'sigterm_verify' && event.outcome === 'identity_unknown'
    && event.signal === 'SIGTERM')).toBeTrue();
  unknownRegistry.release(unknownIdentity);

  const survivorIdentity = identity(8_403);
  const survivorRegistry = new ProcessRegistry({ requireTestMarker: false, alive: () => true,
    captureIdentity: async () => survivorIdentity, signal: () => {} });
  survivorRegistry.registerPid(survivorIdentity.pid, survivorIdentity, { role: 'worker' });
  let survivorError: unknown;
  try { await cleanupProcesses(survivorRegistry); } catch (error) { survivorError = error; }
  const survivorEvidence = evidenceOf(survivorError);
  expect(survivorEvidence.some((event) => event.phase === 'sigkill_wait' && event.outcome === 'survivor'
    && event.signal === 'SIGKILL')).toBeTrue();
  expect(survivorEvidence.length).toBeLessThanOrEqual(8);
  expect(Object.isFrozen(survivorEvidence)).toBeTrue();
  survivorRegistry.release(survivorIdentity);
}, 15_000);

test('defers a TERM-wait unknown until the exact process becomes dead without sending KILL', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8_404, ppid: 1, startToken: 'start', executable: '/bun', commandLine: 'bun worker' };
  let captures = 0;
  let aliveChecks = 0;
  const signals: string[] = [];
  const registry = new ProcessRegistry({ requireTestMarker: false,
    alive: () => aliveChecks++ < 5,
    captureIdentity: async () => captures++ === 0 ? identity : null,
    signal: (_pid, signal) => signals.push(signal),
  });
  registry.registerPid(identity.pid, identity, { role: 'worker' });
  await cleanupProcesses(registry);
  expect(signals).toEqual(['SIGTERM']);
  expect(registry.registeredPids).toEqual([]);
});

test('keeps a persistent unknown blocked through TERM wait and never sends KILL', async () => {
  const identity: ProcessIdentitySnapshot = { pid: 8_405, ppid: 1, startToken: 'start', executable: '/bun', commandLine: 'bun worker' };
  const signals: string[] = [];
  const registry = new ProcessRegistry({ requireTestMarker: false, alive: () => true,
    captureIdentity: async () => null, signal: (_pid, signal) => signals.push(signal) });
  registry.registerPid(identity.pid, identity, { role: 'worker' });
  await expect(cleanupProcesses(registry)).rejects.toBeInstanceOf(AggregateError);
  expect(signals).toEqual([]);
  expect(registry.registeredPids).toEqual([identity.pid]);
  expect(registry.release(identity)).toBeTrue();
});
