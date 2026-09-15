import { expect, test } from 'bun:test';
import { cleanupMaster, descendantProcessSnapshot, freePort, parseWindowsChildPidsOutput, registerDescendantPids, spawnMaster, windowsChildPidsCommand, workerIdentitiesFromSnapshot } from '../fixtures/master-real-process-harness';
import { cleanupProcesses, ProcessRegistry } from '../fixtures/process-cleanup';
import type { ProcessIdentitySnapshot } from '../fixtures/process-cleanup';

test('builds a PID-scoped Windows CIM child query', () => {
  const command = windowsChildPidsCommand(1234);
  expect(command).toContain("Get-CimInstance -ClassName Win32_Process -Filter 'ParentProcessId = 1234'");
  expect(command).not.toContain('Stop-Process');
  expect(() => windowsChildPidsCommand(0)).toThrow();
});

test('parses scalar, array, and empty Windows CIM output without broadening the PID set', () => {
  expect(parseWindowsChildPidsOutput('1234')).toEqual([1234]);
  expect(parseWindowsChildPidsOutput('[1234, 1235, 1234]')).toEqual([1234, 1235]);
  expect(parseWindowsChildPidsOutput('')).toEqual([]);
  expect(parseWindowsChildPidsOutput('not-json')).toEqual([]);
});

test('uses one Windows PPID snapshot as ownership proof without requiring a test marker', () => {
  const identity = (pid: number, ppid: number, roleMarker?: string): ProcessIdentitySnapshot => ({
    pid, ppid, startToken: `creation-${pid}`, executable: 'C:\\bun.exe', commandLine: `bun ${roleMarker ?? 'child'}`,
    ...(roleMarker === undefined ? {} : { roleMarker }),
  });
  const snapshot = [identity(100, 1), identity(101, 100, 'worker'), identity(102, 100, 'ingress'), identity(103, 999, 'worker')];
  expect(descendantProcessSnapshot(snapshot, 100, 'not-present', false).map(({ pid }) => pid)).toEqual([101, 102]);
});

test('registers Windows worker and ingress identities from the PPID proof without a marker', async () => {
  const worker: ProcessIdentitySnapshot = { pid: 111, ppid: 100, startToken: 'creation-worker', executable: 'C:\\bun.exe', commandLine: 'bun worker' };
  const ingress: ProcessIdentitySnapshot = { pid: 112, ppid: 100, startToken: 'creation-ingress', executable: 'C:\\bun.exe', commandLine: 'bun ingress' };
  const registry = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(registry.registerPid(worker.pid, worker, { role: 'worker' })).toBe(worker.pid);
  expect(registry.registerAdoptedIngress(ingress.pid, 3017, ingress)).toBe(ingress.pid);
  expect(registry.registeredProcesses.map(({ role, identity }) => [role, identity?.roleMarker])).toEqual([
    ['worker', undefined], ['ingress', undefined],
  ]);
  await cleanupProcesses(registry);
});

test('recovers a worker after a transient direct-child/descriptor observation gap', () => {
  const worker: ProcessIdentitySnapshot = { pid: 201, ppid: 100, startToken: 'worker-start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker' };
  const snapshot = [worker];
  const oldDirectChildResult = snapshot.filter(({ pid }) => new Set<number>().has(pid));
  expect(oldDirectChildResult).toEqual([]);
  expect(workerIdentitiesFromSnapshot(snapshot, 100, new Set([worker.pid]), 'fixture-marker')).toEqual([worker]);
});

test('does not treat a detached or reparented worker as part of the master tree', () => {
  const worker: ProcessIdentitySnapshot = { pid: 202, ppid: 1, startToken: 'worker-start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker' };
  expect(workerIdentitiesFromSnapshot([worker], 100, new Set([worker.pid]), 'fixture-marker')).toEqual([]);
});

test('does not build a descendant tree from a reused root PID', () => {
  const reusedChild: ProcessIdentitySnapshot = { pid: 202, ppid: 100, startToken: 'new-start', executable: '/usr/bin/bun', commandLine: 'bun unrelated', testMarker: 'other-marker', roleMarker: 'worker' };
  expect(workerIdentitiesFromSnapshot([reusedChild], 100, new Set([reusedChild.pid]), 'fixture-marker')).toEqual([]);
});

test('Windows-style live handles reject reused, malformed, and duplicate root proofs without registering children', async () => {
  const marker = 'BUNGEE_TEST_ROOT_IDENTITY_fixture';
  const root: ProcessIdentitySnapshot = {
    pid: 300, ppid: 1, startToken: 'old-start', executable: 'C:\\bun.exe',
    commandLine: `bun --bungee-test-root-marker=${marker}`,
  };
  const reusedRoot = { ...root, startToken: 'new-start' };
  const child: ProcessIdentitySnapshot = {
    pid: 301, ppid: root.pid, startToken: 'child-start', executable: 'C:\\bun.exe', commandLine: 'bun worker',
  };
  let alive = true;
  const signals: string[] = [];
  const handle: { pid: number; exitCode: number | null; signalCode: string | null; kill: () => void } = {
    pid: root.pid, exitCode: null, signalCode: null, kill: () => { alive = false; },
  };
  const registry = new ProcessRegistry({ platform: 'win32', requireTestMarker: false, alive: () => alive,
    signal: (_pid, signal) => { signals.push(signal); } });
  registry.registerChild(handle, root);
  await registerDescendantPids(registry, [reusedRoot, child], root.pid, {} as never, [3017], marker, root, false);
  for (const malformedRoot of [
    { ...root, commandLine: `bun --bungee-test-root-marker=${marker} --bungee-test-root-marker=${marker}` },
    { ...root, commandLine: 'bun without-root-marker' },
  ]) {
    await registerDescendantPids(registry, [malformedRoot, child], root.pid, {} as never, [3017], marker, root, false);
  }
  expect(registry.registeredPids).toEqual([root.pid]);
  expect(signals).toEqual([]);
  handle.exitCode = 0;
  await cleanupProcesses(registry);
  expect(signals).toEqual([]);
});

test('keeps split and legacy ingress ownership layouts explicit', async () => {
  for (const layout of ['split', 'legacy-single-port'] as const) {
    const port = await freePort();
    const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] }, {
      root: '/tmp/bungee-harness-layout', dbPath: '/tmp/layout.db', accessDbPath: '/tmp/layout-access.db',
      configPath: '/tmp/layout-config.json', pluginsPath: '/tmp/layout-plugins',
    }, port, 1, '/tmp', '/tmp/layout-access.db', {}, { layout });
    try {
      expect(master.ingressPorts).toEqual(layout === 'split' ? [port + 1, port + 2] : [port]);
      if (layout === 'legacy-single-port') {
        const owner = new ProcessRegistry({ alive: () => false });
        const rival = new ProcessRegistry({ alive: () => false });
        const proof: ProcessIdentitySnapshot = {
          pid: 9_100, ppid: 1, startToken: 'legacy-start', executable: '/usr/bin/bun', commandLine: 'bun ingress',
          testMarker: 'legacy-marker', roleMarker: 'ingress',
        };
        expect(owner.registerAdoptedIngress(proof.pid, master.ingressPorts[0]!, proof)).toBe(proof.pid);
        expect(rival.portOwnedByAnother(master.ingressPorts[0]!)).toBeTrue();
        await cleanupProcesses(owner);
      }
    } finally {
      await cleanupMaster(master);
    }
  }
});
