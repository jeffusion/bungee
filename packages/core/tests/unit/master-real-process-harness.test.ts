import { expect, test } from 'bun:test';
import { descendantProcessSnapshot, parseWindowsChildPidsOutput, windowsChildPidsCommand, workerIdentitiesFromSnapshot } from '../fixtures/master-real-process-harness';
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
