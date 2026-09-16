import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { cleanupMaster, cleanupSpawnedProcesses, createFakeRunningMaster, createMasterCleanupScope, createMasterFixture, descendantProcessSnapshot, freePort, masterLifecycleMapSizes, parseWindowsChildPidsOutput, pathExists, probeTcpPort, registerDescendantPids, removeFixture, runWithCleanup, spawnMaster, ROOT_IDENTITY_MISMATCH_MASK, TEST_RESOURCE_BROKER_CLEANUP_ERROR, waitForExit, waitUntil, windowsChildPidsCommand, workerDescriptorsDirectory, workerIdentitiesFromSnapshot, workerObservationDiagnostics, MASTER_ROOT_KEY } from '../fixtures/master-real-process-harness';
import { cleanupProcesses, ProcessRegistry, processAlive } from '../fixtures/process-cleanup';
import type { ProcessIdentitySnapshot } from '../fixtures/process-cleanup';
import { claimTestPortBlock, ensureTestPortBlockClosed, makeTestPortBlock, quarantineAndDetach, releaseTestPortBlock, testPortBlockState } from '../../../../tests/support/test-port-block-broker';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed, signWorkerDescriptor } from '../../src/supervision';

const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

test('preserves primary and cleanup failures in deterministic order', async () => {
  const primary = new Error('primary');
  const cleanup = new Error('cleanup');
  let combined: unknown;
  try { await runWithCleanup(async () => { throw primary; }, async () => { throw cleanup; }); }
  catch (error) { combined = error; }
  expect(combined).toBeInstanceOf(AggregateError);
  expect((combined as AggregateError).errors).toEqual([primary, cleanup]);
  await expect(runWithCleanup(async () => 'ok', async () => { throw cleanup; })).rejects.toBe(cleanup);
  let multiple: unknown;
  try {
    await runWithCleanup(async () => 'ok', [async () => { throw cleanup; }, async () => { throw primary; }]);
  } catch (error) { multiple = error; }
  expect(multiple).toBeInstanceOf(AggregateError);
  expect((multiple as AggregateError).errors).toEqual([cleanup, primary]);
});

test('preserves the primary failure while allowing cleanup to retry', async () => {
  const primary = new Error('primary');
  const transientCleanup = new Error('transient cleanup');
  let attempts = 0;
  let combined: unknown;
  try {
    await runWithCleanup(async () => { throw primary; }, async () => {
      attempts += 1;
      if (attempts === 1) throw transientCleanup;
    });
  } catch (error) { combined = error; }
  expect((combined as AggregateError).errors).toEqual([primary, transientCleanup]);
  await runWithCleanup(async () => undefined, async () => { attempts += 1; });
  expect(attempts).toBe(2);
});

test('captures injected root-exit evidence before the first delayed process snapshot', async () => {
  const rootMarker = 'BUNGEE_TEST_ROOT_IDENTITY_first_snapshot';
  const root: ProcessIdentitySnapshot = {
    pid: 1_001, ppid: 1, startToken: 'root-start', executable: '/usr/bin/bun',
    commandLine: `bun --bungee-test-root-marker=${rootMarker}`,
  };
  const worker: ProcessIdentitySnapshot = {
    pid: 1_002, ppid: root.pid, startToken: 'worker-start', executable: '/usr/bin/bun',
    commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker',
  };
  let rootExited = false;
  const captureSnapshot = async (): Promise<readonly ProcessIdentitySnapshot[]> => {
    await Promise.resolve();
    rootExited = true;
    return [root, worker];
  };
  const snapshot = await captureSnapshot();
  expect(rootExited).toBeTrue();
  expect(workerIdentitiesFromSnapshot(snapshot, root.pid, new Set([worker.pid]), 'fixture-marker', rootMarker)).toEqual([worker]);
});

test('drains an injected delayed monitor without allowing a late capture after stop', async () => {
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotCalls = 0;
  let monitoring = true;
  const writes: number[] = [];
  const captureSnapshot = async (): Promise<readonly ProcessIdentitySnapshot[]> => {
    snapshotCalls += 1;
    await snapshotGate;
    if (monitoring) writes.push(snapshotCalls);
    return [];
  };
  const delayed = captureSnapshot();
  expect(snapshotCalls).toBe(1);
  monitoring = false;
  releaseSnapshot();
  await delayed;
  const callsAfterDrain = snapshotCalls;
  await Promise.resolve();
  expect(snapshotCalls).toBe(callsAfterDrain);
  expect(writes).toEqual([]);
});

test('root-dead cleanup signals a saved exact child but never the exited root', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-dead-child-');
  const root: ProcessIdentitySnapshot = { pid: 1_160, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=root-dead-child' };
  const child: ProcessIdentitySnapshot = { pid: 1_161, ppid: root.pid, startToken: 'child', executable: '/bun', commandLine: 'bun worker', testMarker: 'root-dead-child' };
  const live = new Set([child.pid]);
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root, child], identity: async (pid: number) => pid === child.pid ? child : root,
    alive: (pid: number) => live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'root-dead-child', rootMarker: 'root-dead-child', ports: [41_100], ingressPorts: [41_100], rootPorts: [41_100], workerCount: 0, rootExited: true, probes,
    registered: [{ identity: child, role: 'worker' }] });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(signals.every((signal) => signal.startsWith(`${child.pid}:`))).toBeTrue();
  expect(signals.some((signal) => signal.startsWith(`${root.pid}:`))).toBeFalse();
});

test('root os absence releases its exact handle before a reused PID can be independently claimed', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-reuse-');
  const root: ProcessIdentitySnapshot = { pid: 1_170, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=root-reuse' };
  let rootProbes = 0;
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root], identity: async () => root,
    alive: () => { rootProbes += 1; return false; },
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'root-reuse', rootMarker: 'root-reuse', ports: [41_110], ingressPorts: [41_110], rootPorts: [41_110], workerCount: 0, probes });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  const replacement: ProcessIdentitySnapshot = { ...root, startToken: 'replacement' };
  const owner = new ProcessRegistry({ alive: () => true, requireTestMarker: false });
  expect(owner.registerPid(replacement.pid, replacement, { role: 'worker' })).toBe(replacement.pid);
  owner.release(replacement);
  expect(master.rootExitState.confirmedBy).toBe('os_absence');
  expect(rootProbes).toBe(1);
  expect(signals).toEqual([]);
});

test('mixed saved mismatch and unknown children release mismatch but retain unknown until retry', async () => {
  const fixture = await createMasterFixture('bungee-harness-mixed-children-');
  const root: ProcessIdentitySnapshot = { pid: 1_180, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=mixed-children' };
  const mismatch: ProcessIdentitySnapshot = { pid: 1_181, ppid: root.pid, startToken: 'old', executable: '/bun', commandLine: 'bun mismatch', testMarker: 'mixed-children' };
  const unknown: ProcessIdentitySnapshot = { pid: 1_182, ppid: root.pid, startToken: 'unknown', executable: '/bun', commandLine: 'bun unknown', testMarker: 'mixed-children' };
  const live = new Set([mismatch.pid, unknown.pid]);
  let unknownIdentityCalls = 0;
  const probes = {
    snapshot: async () => [root],
    identity: async (pid: number) => {
      if (pid === mismatch.pid) return { ...mismatch, startToken: 'replacement' };
      if (pid === unknown.pid) return unknownIdentityCalls++ === 0 ? unknown : null;
      return root;
    },
    alive: (pid: number) => live.has(pid),
    signal: (pid: number, _signal: 'SIGTERM' | 'SIGKILL') => live.delete(pid),
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'mixed-children', rootMarker: 'mixed-children', ports: [41_120], ingressPorts: [41_120], rootPorts: [41_120], workerCount: 0, rootExited: true, probes,
    registered: [{ identity: mismatch, role: 'worker' }, { identity: unknown, role: 'worker' }] });
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toBeInstanceOf(AggregateError);
  const mismatchOwner = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(mismatchOwner.registerPid(mismatch.pid, { ...mismatch, startToken: 'replacement' }, { role: 'worker' })).toBe(mismatch.pid);
  mismatchOwner.release({ ...mismatch, startToken: 'replacement' });
  expect(master.processes.ownsPid(unknown.pid)).toBeTrue();
  expect(await pathExists(fixture.root)).toBeTrue();
  live.delete(unknown.pid);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
  const replacement = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(replacement.registerAdoptedIngress(root.pid, 41_120, { ...root, startToken: 'new-root' })).toBe(root.pid);
  await cleanupProcesses(replacement);
});

test('late root exit and close events do not double-settle os absence or lifecycle maps', async () => {
  const fixture = await createMasterFixture('bungee-harness-late-root-events-');
  const root: ProcessIdentitySnapshot = { pid: 1_190, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=late-root-events' };
  const probes = { snapshot: async () => [root], identity: async () => root, alive: () => false, signal: () => {}, port: async () => 'closed' as const };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'late-root-events', rootMarker: 'late-root-events', ports: [41_130], ingressPorts: [41_130], workerCount: 0, probes });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  const state = { ...master.rootExitState };
  const maps = masterLifecycleMapSizes(master.processes, root.pid);
  master.settleRootExit('event', 0, null);
  master.settleRootExit('close', 1, 'SIGTERM');
  expect(master.rootExitState).toEqual(state);
  expect(masterLifecycleMapSizes(master.processes, root.pid)).toEqual(maps);
  expect(maps).toEqual(Object.fromEntries(Object.keys(maps).map((key) => [key, 0])));
});

test('deferred monitoring drain starts coverage and probes only after the drain settles', async () => {
  const fixture = await createMasterFixture('bungee-harness-deferred-drain-');
  const root: ProcessIdentitySnapshot = { pid: 1_200, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=deferred-drain' };
  let releaseDrain!: () => void;
  let drainStarted = false;
  let snapshotCalls = 0;
  let processProbeCalls = 0;
  let portProbeCalls = 0;
  const drainGate = new Promise<void>((resolve) => { releaseDrain = resolve; });
  const probes = {
    snapshot: async () => { snapshotCalls += 1; return [root]; }, identity: async () => root,
    alive: () => { processProbeCalls += 1; return false; }, signal: () => {},
    port: async () => { portProbeCalls += 1; return 'closed' as const; },
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'deferred-drain', rootMarker: 'deferred-drain', ports: [41_140], ingressPorts: [41_140], workerCount: 0, rootExited: true, probes,
    stopMonitoringAndDrain: async () => { drainStarted = true; await drainGate; } });
  const cleanup = cleanupMaster(master, [], { fixture, expectGraceful: false });
  await waitUntil(() => drainStarted, 'fake monitor drain did not start');
  expect(snapshotCalls).toBe(0);
  expect(processProbeCalls).toBe(0);
  expect(portProbeCalls).toBe(0);
  releaseDrain();
  await cleanup;
  expect(snapshotCalls).toBeGreaterThan(0);
  expect(portProbeCalls).toBeGreaterThan(0);
  expect(masterLifecycleMapSizes(master.processes, root.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])));
});

test('runWithCleanup preserves primary before real unknown cleanup, then retries cleanly after root becomes dead', async () => {
  const fixture = await createMasterFixture('bungee-harness-primary-retry-');
  const root: ProcessIdentitySnapshot = { pid: 1_210, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=primary-retry' };
  let mode: 'unknown' | 'dead' = 'unknown';
  const probes = {
    snapshot: async () => [root], identity: async () => root,
    alive: () => { if (mode === 'unknown') throw new Error('unknown root probe'); return false; },
    signal: () => {}, port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'primary-retry', rootMarker: 'primary-retry', ports: [41_150], ingressPorts: [41_150], workerCount: 0, probes });
  const primary = new Error('primary first');
  let failure: unknown;
  try {
    await runWithCleanup(async () => { throw primary; }, async () => cleanupMaster(master, [], { fixture, expectGraceful: false }));
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toBe(primary);
  mode = 'dead';
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
  expect(masterLifecycleMapSizes(master.processes, root.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])));
});

test('reconciles a fresh dead root when its exit event wins the bounded grace', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-event-grace-');
  const root: ProcessIdentitySnapshot = { pid: 1_150, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=event-grace' };
  let rootProbes = 0;
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root], identity: async () => root,
    alive: () => { rootProbes += 1; return false; },
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'event-grace', rootMarker: 'event-grace', ports: [41_000], ingressPorts: [41_000], workerCount: 0, probes });
  setTimeout(() => master.settleRootExit('event', 0, null), 10);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  master.settleRootExit('close', 1, 'SIGTERM');
  expect(master.rootExitState).toMatchObject({ exited: true, code: 0, signal: null, confirmedBy: 'event' });
  expect(rootProbes).toBe(1);
  expect(signals).toEqual([]);
});

test('marks os absence after bounded grace without probing or signalling the root again', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-os-absence-');
  const root: ProcessIdentitySnapshot = { pid: 1_151, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=os-absence' };
  let rootProbes = 0;
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root], identity: async () => root,
    alive: () => { rootProbes += 1; return false; },
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'os-absence', rootMarker: 'os-absence', ports: [41_010], ingressPorts: [41_010], workerCount: 0, probes });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.rootExitState).toMatchObject({ exited: true, code: null, signal: null, confirmedBy: 'os_absence' });
  expect(rootProbes).toBe(1);
  expect(signals).toEqual([]);
});

test('probes TCP state without treating HTTP responses as closed ports', async () => {
  const notFound = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('missing', { status: 404 }) });
  const hanging = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) });
  const portScope = createMasterCleanupScope();
  try {
    const closed = await freePort(portScope);
    expect(await probeTcpPort(notFound.port!)).toBe('open');
    expect(await probeTcpPort(hanging.port!)).toBe('open');
    expect(await probeTcpPort(closed)).toBe('closed');
  } finally {
    await notFound.stop(true);
    await hanging.stop(true);
    await cleanupSpawnedProcesses(portScope);
  }
});

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
  const rootMarker = 'BUNGEE_TEST_ROOT_IDENTITY_transient';
  const root: ProcessIdentitySnapshot = {
    pid: 100, ppid: 1, startToken: 'root-start', executable: '/usr/bin/bun',
    commandLine: `bun --bungee-test-root-marker=${rootMarker}`,
  };
  const worker: ProcessIdentitySnapshot = { pid: 201, ppid: 100, startToken: 'worker-start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker' };
  const snapshot = [root, worker];
  const oldDirectChildResult = snapshot.filter(({ pid }) => new Set<number>().has(pid));
  expect(oldDirectChildResult).toEqual([]);
  expect(workerIdentitiesFromSnapshot(snapshot, 100, new Set([worker.pid]), 'fixture-marker', rootMarker)).toEqual([worker]);
});

test('legacy registration keeps the listener port on the root and adopts every rooted generic child', async () => {
  const marker = 'legacy-root';
  const root: ProcessIdentitySnapshot = {
    pid: 9_200, ppid: 1, startToken: 'legacy-root', executable: '/usr/bin/bun',
    commandLine: `bun --bungee-test-root-marker=${marker}`,
  };
  const child: ProcessIdentitySnapshot = {
    pid: 9_201, ppid: root.pid, startToken: 'legacy-child', executable: '/usr/bin/bun', commandLine: 'bun plugin',
  };
  const grandchild: ProcessIdentitySnapshot = {
    pid: 9_202, ppid: child.pid, startToken: 'legacy-grandchild', executable: '/usr/bin/bun', commandLine: 'bun plugin-child',
  };
  const registry = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  registry.registerChild({ pid: root.pid, exitCode: null, signalCode: null, kill: () => {} }, root, { ports: [9_203] });
  await registerDescendantPids(registry, [root, child, grandchild], root.pid, {} as never, [9_203], marker, root, false);
  expect(registry.registeredProcesses).toEqual(expect.arrayContaining([
    expect.objectContaining({ pid: root.pid, ports: [9_203] }),
    expect.objectContaining({ pid: child.pid }), expect.objectContaining({ pid: grandchild.pid }),
  ]));
  expect(registry.registeredProcesses.filter(({ pid }) => pid !== root.pid).every(({ ports }) => ports === undefined)).toBeTrue();
  await cleanupProcesses(registry);
});

test('split registration keeps a rooted plugin child generic while giving exact ingress ports only to ingress', async () => {
  const marker = 'split-root';
  const root: ProcessIdentitySnapshot = {
    pid: 9_210, ppid: 1, startToken: 'split-root', executable: '/usr/bin/bun',
    commandLine: `bun --bungee-test-root-marker=${marker}`,
  };
  const plugin: ProcessIdentitySnapshot = {
    pid: 9_211, ppid: root.pid, startToken: 'split-plugin', executable: '/usr/bin/bun', commandLine: 'bun plugin',
  };
  const ingress: ProcessIdentitySnapshot = {
    pid: 9_212, ppid: root.pid, startToken: 'split-ingress', executable: '/usr/bin/bun',
    commandLine: 'bun ingress --bungee-process-identity=70000000-0000-4000-8000-000000000001',
  };
  const registry = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  registry.registerChild({ pid: root.pid, exitCode: null, signalCode: null, kill: () => {} }, root);
  await registerDescendantPids(registry, [root, plugin, ingress], root.pid, { root: '/tmp/bungee-split-plugin' } as never, [9_213, 9_214], marker, root, false);
  expect(registry.registeredProcesses.find(({ pid }) => pid === plugin.pid)).toMatchObject({ pid: plugin.pid });
  expect(registry.registeredProcesses.find(({ pid }) => pid === plugin.pid)?.ports).toBeUndefined();
  expect(registry.registeredProcesses.find(({ pid }) => pid === plugin.pid)?.role).toBeUndefined();
  expect(registry.registeredProcesses.find(({ pid }) => pid === ingress.pid)).toMatchObject({
    pid: ingress.pid, role: 'ingress', ports: [9_213, 9_214],
  });
  await cleanupProcesses(registry);
});

test('active rooted cleanup coverage rejects an unrelated valid worker descriptor', async () => {
  const fixture = await createMasterFixture('bungee-harness-rooted-descriptor-');
  const testMarker = 'active-rooted';
  const rootMarker = 'active-root';
  const root: ProcessIdentitySnapshot = { pid: 7_100, ppid: 1, startToken: 'root', executable: '/bun', commandLine: `bun --bungee-test-root-marker=${rootMarker}` };
  const worker: ProcessIdentitySnapshot = { pid: 7_101, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun --bungee-process-identity=71000000-0000-4000-8000-000000000001', testMarker };
  const ingress: ProcessIdentitySnapshot = { pid: 7_102, ppid: root.pid, startToken: 'ingress', executable: '/bun', commandLine: 'bun --bungee-process-identity=71000000-0000-4000-8000-000000000002', testMarker, roleMarker: 'ingress' };
  const unrelated: ProcessIdentitySnapshot = { pid: 7_103, ppid: 9_999, startToken: 'unrelated', executable: '/bun', commandLine: 'bun --bungee-process-identity=71000000-0000-4000-8000-000000000003', testMarker };
  const live = new Set([root.pid, worker.pid, ingress.pid, unrelated.pid]);
  const snapshot = [root, worker, ingress, unrelated];
  const signals: string[] = [];
  const probes = {
    snapshot: async () => snapshot,
    identity: async (pid: number) => snapshot.find((identity) => identity.pid === pid) ?? null,
    alive: (pid: number) => live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
  };
  const descriptor = signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: '71000000-0000-4000-8000-000000000004',
    worker_instance_id: '71000000-0000-4000-8000-000000000001', worker_slot: 0, boot_nonce: '71000000-0000-4000-8000-000000000005', pid: worker.pid,
    control_port: 40_010, phase: 'serving', frozen: false, private_port: 40_020, revision: 1,
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', started_at: 1, evidence: { kind: 'candidate' },
  }, deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, '71000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000001', 0), '71000000-0000-4000-8000-000000000005').process_key);
  const unrelatedDescriptor = signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: '71000000-0000-4000-8000-000000000004',
    worker_instance_id: '71000000-0000-4000-8000-000000000003', worker_slot: 1, boot_nonce: '71000000-0000-4000-8000-000000000005', pid: unrelated.pid,
    control_port: 40_011, phase: 'serving', frozen: false, private_port: 40_021, revision: 1,
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', started_at: 1, evidence: { kind: 'candidate' },
  }, deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, '71000000-0000-4000-8000-000000000004', '71000000-0000-4000-8000-000000000003', 1), '71000000-0000-4000-8000-000000000005').process_key);
  await mkdir(workerDescriptorsDirectory(fixture), { recursive: true });
  const workerDirectory = workerDescriptorsDirectory(fixture);
  await writeFile(join(workerDirectory, '71000000-0000-4000-8000-000000000001.json'), `${JSON.stringify(descriptor)}\n`);
  await writeFile(join(workerDirectory, '71000000-0000-4000-8000-000000000003.json'), `${JSON.stringify(unrelatedDescriptor)}\n`);
  const master = createFakeRunningMaster({ fixture, root, testMarker, rootMarker, ports: [40_000, 40_001, 40_002], ingressPorts: [40_001, 40_002], workerCount: 1, probes,
    savedDescriptors: [{ file: join(workerDirectory, '71000000-0000-4000-8000-000000000001.json'), descriptor }] as never,
    registered: [{ identity: worker, role: 'worker' }, { identity: ingress, role: 'ingress', ports: [40_001, 40_002] }] });
  let failure: unknown;
  try {
    await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
    expect(master.processes.ownsPid(unrelated.pid)).toBeFalse();
    expect(live.has(root.pid)).toBeTrue();
    expect(signals).toEqual([]);
    const owner = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
    expect(owner.registerPid(unrelated.pid, unrelated, { role: 'worker' })).toBe(unrelated.pid);
    await cleanupProcesses(owner);
  } catch (error) { failure = error; }
  finally {
    live.clear();
    master.settleRootExit('os_absence', null, null);
    await cleanupMaster(master, [], { fixture, expectGraceful: false, probePort: probes.port });
    expect(signals).toEqual([]);
  }
  if (failure !== undefined) throw failure;
});

test('root-dead current signed descriptor without saved identity fails closed', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-dead-unsaved-');
  const root: ProcessIdentitySnapshot = { pid: 7_200, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=root-dead' };
  const worker: ProcessIdentitySnapshot = { pid: 7_201, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: '--bungee-process-identity=72000000-0000-4000-8000-000000000001', testMarker: 'root-dead' };
  const live = new Set([worker.pid]);
  const signals: string[] = [];
  const probes = { snapshot: async () => [root], identity: async () => worker, alive: (pid: number) => live.has(pid), signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); }, port: async () => 'closed' as const };
  const descriptor = signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: '72000000-0000-4000-8000-000000000002',
    worker_instance_id: '72000000-0000-4000-8000-000000000001', worker_slot: 0, boot_nonce: '72000000-0000-4000-8000-000000000003', pid: worker.pid,
    control_port: 40_006, phase: 'serving', frozen: false, private_port: 40_007, revision: 1,
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', started_at: 1, evidence: { kind: 'candidate' },
  }, deriveWorkerSupervisionCredential(deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, '72000000-0000-4000-8000-000000000002', '72000000-0000-4000-8000-000000000001', 0), '72000000-0000-4000-8000-000000000003').process_key);
  const descriptorPath = join(workerDescriptorsDirectory(fixture), '72000000-0000-4000-8000-000000000001.json');
  await mkdir(workerDescriptorsDirectory(fixture), { recursive: true });
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`);
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'root-dead', rootMarker: 'root-dead', ports: [40_006, 40_007, 40_008], ingressPorts: [40_007, 40_008], workerCount: 0, rootExited: true, probes });
  let failure: unknown;
  try {
    await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
    expect(master.processes.ownsPid(worker.pid)).toBeFalse();
    expect(signals).toEqual([]);
    expect(await pathExists(fixture.root)).toBeTrue();
  } catch (error) { failure = error; }
  finally {
    await rm(descriptorPath, { force: true });
    live.clear();
    await cleanupMaster(master, [], { fixture, expectGraceful: false, probePort: probes.port });
  }
  if (failure !== undefined) throw failure;
});

test('cleanup accepts a dead signed descriptor without registering or signalling its PID', async () => {
  const fixture = await createMasterFixture('bungee-harness-dead-descriptor-');
  const port = 40_300;
  const root: ProcessIdentitySnapshot = { pid: 7_300, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=dead-descriptor' };
  const deadPid = 999_999_999;
  const generation = '70000000-0000-4000-8000-000000000003';
  const instance = '70000000-0000-4000-8000-000000000004';
  const bootNonce = '70000000-0000-4000-8000-000000000005';
  const credential = deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, 0), bootNonce,
  );
  const descriptor = signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: generation,
    worker_instance_id: instance, worker_slot: 0, boot_nonce: bootNonce, pid: deadPid,
    control_port: 40_001, phase: 'stopped', frozen: true, private_port: null, revision: null,
    content_hash: null, plugin_catalog_hash: null, started_at: 0, evidence: { kind: 'candidate' },
  }, credential.process_key);
  await mkdir(workerDescriptorsDirectory(fixture), { recursive: true });
  const descriptorPath = join(workerDescriptorsDirectory(fixture), `${instance}.json`);
  await writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`, 'utf8');
  const live = new Set<number>();
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root],
    identity: async (pid: number) => [root].find((identity) => identity.pid === pid) ?? null,
    alive: (pid: number) => live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'dead-descriptor', rootMarker: 'dead-descriptor', ports: [port], ingressPorts: [port], rootPorts: [port], workerCount: 0, rootExited: true, probes });
  let failure: unknown;
  try {
    expect(master.processes.ownsPid(deadPid)).toBeFalse();
    await cleanupMaster(master, [], { fixture, expectGraceful: false });
    expect(signals).toEqual([]);
  } catch (error) { failure = error; }
  finally {
    if (failure !== undefined) {
      live.clear();
      master.rootExitState.exited = true;
      await rm(descriptorPath, { force: true });
      await cleanupMaster(master, [], { fixture, expectGraceful: false, probePort: probes.port });
    }
  }
  if (failure !== undefined) throw failure;
});

test('does not treat a detached or reparented worker as part of the master tree', () => {
  const worker: ProcessIdentitySnapshot = { pid: 202, ppid: 1, startToken: 'worker-start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker' };
  expect(workerIdentitiesFromSnapshot([worker], 100, new Set([worker.pid]), 'fixture-marker')).toEqual([]);
});

test('does not build a descendant tree from a reused root PID', () => {
  const reusedChild: ProcessIdentitySnapshot = { pid: 202, ppid: 100, startToken: 'new-start', executable: '/usr/bin/bun', commandLine: 'bun unrelated', testMarker: 'other-marker', roleMarker: 'worker' };
  expect(workerIdentitiesFromSnapshot([reusedChild], 100, new Set([reusedChild.pid]), 'fixture-marker')).toEqual([]);
});

test('uses the passed master proof for same-PID roots and masks a mismatch without signalling', async () => {
  const scopeA = createMasterCleanupScope();
  const scopeB = createMasterCleanupScope();
  const fixtureA = await createMasterFixture('bungee-harness-root-proof-a-');
  const fixtureB = await createMasterFixture('bungee-harness-root-proof-b-');
  const rootA: ProcessIdentitySnapshot = { pid: 50_200, ppid: 1, startToken: 'start-a', executable: '/bun-a', commandLine: '--bungee-test-root-marker=root-a', testMarker: 'test-a', roleMarker: 'role-a' };
  const rootB: ProcessIdentitySnapshot = { pid: rootA.pid, ppid: 1, startToken: 'start-b', executable: '/bun-b', commandLine: '--bungee-test-root-marker=root-b', testMarker: 'test-b', roleMarker: 'role-b' };
  const signals: string[] = [];
  const probes = { snapshot: async () => [], identity: async () => null, alive: () => false, signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`), port: async () => 'closed' as const };
  const masterA = createFakeRunningMaster({ fixture: fixtureA, root: rootA, testMarker: 'test-a', rootMarker: 'root-a', ports: [50_210], ingressPorts: [50_210], workerCount: 0, rootExited: true, probes, cleanupScope: scopeA });
  const masterB = createFakeRunningMaster({ fixture: fixtureB, root: rootB, testMarker: 'test-b', rootMarker: 'root-b', ports: [50_220], ingressPorts: [50_220], workerCount: 0, rootExited: true, probes, cleanupScope: scopeB });
  const workerA: ProcessIdentitySnapshot = { pid: 50_201, ppid: rootA.pid, startToken: 'worker-a', executable: '/bun', commandLine: 'bun worker', testMarker: 'test-a', roleMarker: 'worker' };
  const workerB: ProcessIdentitySnapshot = { ...workerA, pid: 50_202, ppid: rootB.pid, startToken: 'worker-b', testMarker: 'test-b' };
  try {
    expect(workerIdentitiesFromSnapshot([rootA, workerA], rootA.pid, new Set([workerA.pid]), masterA.testMarker, masterA.rootMarker, masterA)).toEqual([workerA]);
    expect(workerIdentitiesFromSnapshot([rootB], rootB.pid, new Set(), masterA.testMarker, masterA.rootMarker, masterA)).toEqual([]);
    expect(workerIdentitiesFromSnapshot([rootB, workerB], rootB.pid, new Set([workerB.pid]), masterB.testMarker, masterB.rootMarker, masterB)).toEqual([workerB]);
    expect(workerObservationDiagnostics(masterA, new Set(), [rootB])).toContain(`root_identity_mismatch_fields=${ROOT_IDENTITY_MISMATCH_MASK}`);
    expect(signals).toEqual([]);
  } finally {
    await cleanupSpawnedProcesses(scopeA);
    await cleanupSpawnedProcesses(scopeB);
  }
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
    const port = await freePort(cleanupScope);
    const master = spawnMaster(cleanupScope, { name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] }, {
      root: '/tmp/bungee-harness-layout', dbPath: '/tmp/layout.db', accessDbPath: '/tmp/layout-access.db',
      configPath: '/tmp/layout-config.json', pluginsPath: '/tmp/layout-plugins',
    }, port, 1, '/tmp', '/tmp/layout-access.db', {}, { layout });
    await runWithCleanup(async () => {
      expect(master.ingressPorts).toEqual(layout === 'split' ? [port + 1, port + 2] : [port]);
      if (layout === 'legacy-single-port') {
        expect(master.processes.registeredProcesses.find(({ pid }) => pid === master.child.pid)?.ports).toEqual([port]);
        const owner = new ProcessRegistry({ alive: () => false });
        const rival = new ProcessRegistry({ alive: () => false });
        const proof: ProcessIdentitySnapshot = {
          pid: 9_100, ppid: 1, startToken: 'legacy-start', executable: '/usr/bin/bun', commandLine: 'bun ingress',
          testMarker: 'legacy-marker', roleMarker: 'ingress',
        };
        const legacyOwnerPort = master.ingressPorts[0]! + 10;
        expect(owner.registerAdoptedIngress(proof.pid, legacyOwnerPort, proof)).toBe(proof.pid);
        expect(rival.portOwnedByAnother(legacyOwnerPort)).toBeTrue();
        await cleanupProcesses(owner);
      }
    }, async () => {
      await cleanupMaster(master, [], { expectGraceful: false });
      expect(masterLifecycleMapSizes(master.processes, master.child.pid)).toEqual(
        Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])),
      );
    });
  }
});

test('accepts a live root with no registered ingress when all known ports are closed', async () => {
  const master = spawnMaster(cleanupScope, { name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] }, {
    root: '/tmp/bungee-harness-coverage', dbPath: '/tmp/coverage.db', accessDbPath: '/tmp/coverage-access.db',
    configPath: '/tmp/coverage-config.json', pluginsPath: '/tmp/coverage-plugins',
  }, await freePort(cleanupScope), 1, '/tmp', '/tmp/coverage-access.db', {}, { stopProcessMonitor: true });
  await cleanupMaster(master);
  expect(master.processes.registeredPids).toEqual([]);
  expect(processAlive(master.child.pid!)).toBeFalse();
});

test('reclaims an early-exited root before the first identity snapshot when ports are closed', async () => {
  const fixture = await createMasterFixture('bungee-harness-early-exit-');
  const master = spawnMaster(cleanupScope, { name: 'source', executable: process.execPath, args: ['-e', 'process.exit(0)'] }, fixture, await freePort(cleanupScope), 0);
  await master.rootExit;
  await cleanupMaster(master, [], { fixture });
  expect(master.processes.registeredPids).toEqual([]);
});

test.serial('clears every lifecycle map after normal, startup, and active cleanup', async () => {
  for (const [prefix, script, waitForExitFirst] of [
    ['normal', 'setInterval(() => {}, 60_000)', false],
    ['startup', 'process.exit(0)', true],
    ['active', 'setInterval(() => {}, 60_000)', false],
  ] as const) {
    const fixture = await createMasterFixture(`bungee-harness-${prefix}-maps-`);
    const master = spawnMaster(cleanupScope, { name: 'source', executable: process.execPath, args: ['-e', script] },
      fixture, await freePort(cleanupScope), 0);
    if (master.child.pid === undefined) throw new Error('master PID is unavailable');
    const empty = Object.fromEntries(Object.keys(masterLifecycleMapSizes(master.processes, master.child.pid)).map((key) => [key, 0]));
    if (waitForExitFirst) await master.rootExit;
    await cleanupMaster(master, [], { fixture });
    expect(masterLifecycleMapSizes(master.processes, master.child.pid)).toEqual(empty);
  }
});

test('scoped cleanup only touches its own registries and leaves another scope live', async () => {
  const scopeA = createMasterCleanupScope();
  const scopeB = createMasterCleanupScope();
  const fixtureA = await createMasterFixture('bungee-harness-scope-a-');
  const fixtureB = await createMasterFixture('bungee-harness-scope-b-');
  const rootA: ProcessIdentitySnapshot = { pid: 1_300, ppid: 1, startToken: 'a', executable: '/bun', commandLine: '--bungee-test-root-marker=scope-a' };
  const rootB: ProcessIdentitySnapshot = { pid: 1_301, ppid: 1, startToken: 'b', executable: '/bun', commandLine: '--bungee-test-root-marker=scope-b' };
  const makeProbes = (root: ProcessIdentitySnapshot) => ({
    snapshot: async () => [root], identity: async () => root, alive: () => false, signal: () => {}, port: async () => 'closed' as const,
  });
  const masterA = createFakeRunningMaster({ fixture: fixtureA, root: rootA, testMarker: 'scope-a', rootMarker: 'scope-a', ports: [41_300], ingressPorts: [41_300], workerCount: 0, rootExited: true, probes: makeProbes(rootA), cleanupScope: scopeA });
  const masterB = createFakeRunningMaster({ fixture: fixtureB, root: rootB, testMarker: 'scope-b', rootMarker: 'scope-b', ports: [41_301], ingressPorts: [41_301], workerCount: 0, rootExited: true, probes: makeProbes(rootB), cleanupScope: scopeB });
  await cleanupSpawnedProcesses(scopeA);
  expect(masterLifecycleMapSizes(masterA.processes, rootA.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])));
  expect(masterB.processes.registeredPids).toEqual([rootB.pid]);
  expect(masterLifecycleMapSizes(masterB.processes, rootB.pid).runningMasters).toBe(1);
  await cleanupSpawnedProcesses(scopeB);
  expect(masterLifecycleMapSizes(masterB.processes, rootB.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])));
});

test('quarantines a failed block, keeps the next scope disjoint, honors exclusions, and releases success', async () => {
  const scopeA = createMasterCleanupScope();
  const baseA = await freePort(scopeA);
  const identity: ProcessIdentitySnapshot = { pid: 41_400, ppid: 1, startToken: 'broker-failure', executable: '/bun', commandLine: 'bun broker-failure' };
  const registry = new ProcessRegistry({
    alive: () => true, captureIdentity: async () => { throw new Error('cleanup probe failed'); }, signal: () => {}, requireTestMarker: false,
  });
  registry.registerPid(identity.pid, identity, { role: 'worker' });
  scopeA.registries.add(registry);
  let cleanupError: unknown;
  try { await cleanupSpawnedProcesses(scopeA); }
  catch (error) { cleanupError = error; }
  expect((cleanupError as Error).message).toBe(TEST_RESOURCE_BROKER_CLEANUP_ERROR);
  expect(scopeA.portBlocks.size).toBe(0);
  expect(claimTestPortBlock(makeTestPortBlock(baseA))).toBeFalse();
  registry.release(identity);
  scopeA.registries.clear();

  const excluded = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('excluded') });
  try {
    const baseB = await freePort(scopeA, [excluded.port!]);
    expect(scopeA.portBlocks.size).toBe(1);
    const portsB = scopeA.portBlocks.values().next().value!.ports;
    expect(portsB[0]).toBe(baseB);
    expect(portsB).not.toContain(excluded.port);
    expect(portsB.some((port) => [baseA, baseA + 1, baseA + 2].includes(port))).toBeFalse();
    expect(await Promise.all(portsB.map((port) => probeTcpPort(port)))).toEqual(['closed', 'closed', 'closed']);
    await cleanupSpawnedProcesses(scopeA);
    expect(scopeA.portBlocks.size).toBe(0);
    const released = makeTestPortBlock(baseB);
    expect(claimTestPortBlock(released)).toBeTrue();
    expect(releaseTestPortBlock(released)).toBeTrue();
  } finally {
    await excluded.stop(true);
  }
});

test('physical block close waits through open, unknown/reset, and closed states', async () => {
  const block = makeTestPortBlock(50_000);
  expect(claimTestPortBlock(block)).toBeTrue();
  const attempts = new Map<number, number>();
  let now = 0;
  let sleeps = 0;
  try {
    await ensureTestPortBlockClosed(block, {
      probe: async (port) => {
        const attempt = attempts.get(port) ?? 0;
        attempts.set(port, attempt + 1);
        if (attempt === 1) throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
        return attempt === 0 ? 'open' : 'closed';
      },
      sleep: async (milliseconds) => { sleeps += 1; now += milliseconds; },
      now: () => now,
    });
    expect(sleeps).toBe(2);
    expect(testPortBlockState(block)).toBe('active');
  } finally {
    releaseTestPortBlock(block);
  }
});

test('physical close deadline quarantines a block and prevents reissue without real sleep', async () => {
  const block = makeTestPortBlock(50_100);
  const scope = { portBlocks: new Set([block]) };
  expect(claimTestPortBlock(block)).toBeTrue();
  let now = 0;
  try {
    await expect(ensureTestPortBlockClosed(block, {
      probe: async () => 'unknown',
      sleep: async (milliseconds) => { now += milliseconds; },
      now: () => now,
    })).rejects.toThrow('test port block physical close deadline exceeded');
    expect(testPortBlockState(block)).toBe('quarantined');
    expect(claimTestPortBlock(block)).toBeFalse();
    expect(quarantineAndDetach(scope, block)).toBeFalse();
    expect(scope.portBlocks.size).toBe(0);
  } finally {
    scope.portBlocks.clear();
  }
});

test('Linux terminal root state settles os_terminal and never signals the reused PID', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-terminal-');
  const root: ProcessIdentitySnapshot = { pid: 1_310, ppid: 1, startToken: 'terminal', executable: '/bun', commandLine: '--bungee-test-root-marker=root-terminal' };
  const signals: string[] = [];
  const probes = {
    snapshot: async () => [root], identity: async () => root, alive: () => false,
    liveness: () => 'terminal' as const,
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`), port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'root-terminal', rootMarker: 'root-terminal', ports: [41_310], ingressPorts: [41_310], workerCount: 0, probes });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.rootExitState.confirmedBy).toBe('os_terminal');
  expect(signals).toEqual([]);
  const replacement = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
  expect(replacement.registerPid(root.pid, { ...root, startToken: 'replacement' }, { role: 'worker' })).toBe(root.pid);
  await cleanupProcesses(replacement);
});

test('unknown transition retries within the deadline and accepts an exit event during the yield', async () => {
  const makeCase = async (prefix: string, event: boolean) => {
    const fixture = await createMasterFixture(`bungee-harness-unknown-transition-${prefix}-`);
    const root: ProcessIdentitySnapshot = { pid: event ? 1_320 : 1_321, ppid: 1, startToken: prefix, executable: '/bun', commandLine: `--bungee-test-root-marker=${prefix}` };
    let mode: 'alive' | 'dead' = 'alive';
    const signals: string[] = [];
    const master = createFakeRunningMaster({ fixture, root, testMarker: prefix, rootMarker: prefix, ports: [event ? 41_320 : 41_321], ingressPorts: [event ? 41_320 : 41_321], workerCount: 0, probes: {
      snapshot: async () => mode === 'alive' ? [] : [root], identity: async () => root, alive: () => mode === 'alive',
      signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`), port: async () => 'closed' as const,
    } });
    if (event) setTimeout(() => { mode = 'dead'; master.settleRootExit('event', 0, null); }, 10);
    let failure: unknown;
    try { await cleanupMaster(master, [], { fixture, expectGraceful: false }); }
    catch (error) { failure = error; }
    if (event) {
      expect(failure).toBeUndefined();
      expect(master.rootExitState.confirmedBy).toBe('event');
    } else {
      expect(failure).toBeInstanceOf(Error);
      expect(signals).toEqual([]);
      expect(await pathExists(fixture.root)).toBeTrue();
      master.settleRootExit('os_absence', null, null);
      mode = 'dead';
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    }
  };
  await makeCase('unknown-deadline', false);
  await makeCase('unknown-event', true);
});

test('live root direct proof supplements a global snapshot that omitted the root', async () => {
  const fixture = await createMasterFixture('bungee-harness-direct-root-supplement-');
  const root: ProcessIdentitySnapshot = { pid: 1_330, ppid: 1, startToken: 'direct', executable: '/bun', commandLine: '--bungee-test-root-marker=direct-root' };
  const live = new Set([root.pid]);
  const signals: string[] = [];
  let master!: ReturnType<typeof createFakeRunningMaster>;
  const probes = {
    snapshot: async () => [], identity: async () => root, alive: (pid: number) => live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); }, port: async () => 'closed' as const,
  };
  master = createFakeRunningMaster({ fixture, root, testMarker: 'direct-root', rootMarker: 'direct-root', ports: [41_330], ingressPorts: [41_330], rootPorts: [41_330], workerCount: 0, probes,
    onKill: () => master.settleRootExit('event', 0, null) });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.rootExitState.confirmedBy).toBe('event');
  expect(signals).toEqual([]);
});

test('missing direct root proof fails closed while a saved replacement releases only the old owner', async () => {
  const runCase = async (kind: 'missing' | 'mismatch', pid: number) => {
    const fixture = await createMasterFixture(`bungee-harness-direct-root-${kind}-`);
    const root: ProcessIdentitySnapshot = { pid, ppid: 1, startToken: kind, executable: '/bun', commandLine: `--bungee-test-root-marker=direct-${kind}`, testMarker: `direct-${kind}` };
    const signals: string[] = [];
    let replaced = false;
    const probes = {
      snapshot: async () => [replaced ? { ...root, startToken: 'replacement' } : root],
      identity: async () => kind === 'missing' ? null : replaced ? { ...root, startToken: 'replacement' } : root, alive: () => true,
      signal: (childPid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${childPid}:${signal}`), port: async () => 'closed' as const,
    };
    const master = createFakeRunningMaster({ fixture, root, testMarker: `direct-${kind}`, rootMarker: `direct-${kind}`, ports: [41_340], ingressPorts: [41_340], rootPorts: [41_340], workerCount: 0, probes });
    if (kind === 'missing') {
      await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow();
      expect(signals).toEqual([]);
      expect(await pathExists(fixture.root)).toBeTrue();
      master.settleRootExit('os_absence', null, null);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    } else {
      await master.synchronizeOwnership();
      replaced = true;
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
      expect(master.rootExitState.confirmedBy).toBe('os_replaced');
      expect(master.processes.ownsPid(pid)).toBeFalse();
      expect(signals).toEqual([]);
    }
  };
  await runCase('missing', 1_341);
  await runCase('mismatch', 1_342);
});

test('Darwin accepts one rooted UUID ingress without an env marker and rejects two candidates', async () => {
  const runCase = async (count: 1 | 2, pidBase: number) => {
    const fixture = await createMasterFixture(`bungee-harness-darwin-ingress-${count}-`);
    const root: ProcessIdentitySnapshot = { pid: pidBase, ppid: 1, startToken: `darwin-root-${count}`, executable: '/bun', commandLine: `--bungee-test-root-marker=darwin-${count}` };
    const candidates = Array.from({ length: count }, (_, index) => ({
      pid: pidBase + index + 1, ppid: root.pid, startToken: `ingress-${index}`, executable: '/bun',
      commandLine: `bun --bungee-process-identity=00000000-0000-4000-8000-00000000000${index + 1}`,
    }));
    const live = new Set([root.pid, ...candidates.map(({ pid }) => pid)]);
    const signals: string[] = [];
    let master!: ReturnType<typeof createFakeRunningMaster>;
    const probes = {
      snapshot: async () => [root, ...candidates], identity: async (pid: number) => [root, ...candidates].find((identity) => identity.pid === pid) ?? null,
      alive: (pid: number) => live.has(pid), platform: 'darwin' as const,
      signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); }, port: async () => 'closed' as const,
    };
    master = createFakeRunningMaster({ fixture, root, testMarker: `darwin-${count}`, rootMarker: `darwin-${count}`, ports: [41_350, 41_351], ingressPorts: [41_350, 41_351], workerCount: 0, probes,
      onKill: () => master.settleRootExit('event', 0, null) });
    if (count === 1) {
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
      expect(signals).toContain(`${candidates[0]!.pid}:SIGTERM`);
    } else {
      await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow();
      expect(signals).toEqual([]);
      expect(await pathExists(fixture.root)).toBeTrue();
      master.settleRootExit('os_absence', null, null);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    }
  };
  await runCase(1, 1_350);
  await runCase(2, 1_360);
});
