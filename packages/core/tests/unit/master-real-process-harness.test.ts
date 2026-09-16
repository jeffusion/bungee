import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, test } from 'bun:test';
import { __testCaptureOwnedSnapshotSafely, cleanupMaster, cleanupSpawnedProcesses, classifyDescriptorReadError, createFakeRunningMaster, createMasterCleanupScope, createMasterFixture, createTestPhaseBudget, descendantProcessSnapshot, freePort, isRetryableOwnedSnapshotObservation, masterLifecycleMapSizes, ownedSnapshotObservationEvidence, parseWindowsChildPidsOutput, pathExists, probeTcpPort, registerDescendantPids, removeFixture, restoreDescriptorBackups, rootIdentityMismatchFields, runWithCleanup, spawnMaster, TEST_RESOURCE_BROKER_CLEANUP_ERROR, waitForExit, waitForWorkerPids, waitUntil, windowsChildPidsCommand, workerDescriptorsDirectory, workerIdentitiesFromSnapshot, workerObservationDiagnostics, writeRootProof, rootProofWriteEvidence, MASTER_ROOT_KEY, type RunningMaster } from '../fixtures/master-real-process-harness';
import { SupervisionProtocolError } from '../../src/supervision';
import { cleanupProcesses, ProcessRegistry, processAlive, WindowsOwnedSnapshotError } from '../fixtures/process-cleanup';
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

test('Windows cleanup uses the injected owned snapshot provider instead of a global snapshot', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-snapshot-provider-');
  const root: ProcessIdentitySnapshot = { pid: 1_165, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-snapshot-provider' };
  let globalCalls = 0;
  let ownedCalls = 0;
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-snapshot-provider', rootMarker: 'owned-snapshot-provider', ports: [41_105], ingressPorts: [41_105], workerCount: 0, probes: {
    snapshot: async () => { globalCalls += 1; throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async () => { ownedCalls += 1; return [root]; },
    identity: async () => root, alive: () => false, signal: () => {}, port: async () => 'closed' as const, platform: 'win32',
  }, rootExited: true });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(ownedCalls).toBeGreaterThan(0);
  expect(globalCalls).toBe(0);
});

test('Windows root exit queries a reparented saved worker and signals only that worker', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-reparented-worker-');
  const root: ProcessIdentitySnapshot = { pid: 1_360, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-reparented-worker' };
  const worker: ProcessIdentitySnapshot = { pid: 1_361, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun --worker' };
  const live = new Set([worker.pid]);
  const signals: string[] = [];
  let globalCalls = 0;
  let requested: readonly number[] = [];
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-reparented-worker', rootMarker: 'owned-reparented-worker', ports: [41_360], ingressPorts: [41_360], rootPorts: [41_360], workerCount: 0, rootExited: true, probes: {
    snapshot: async () => { globalCalls += 1; throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (rootPid, requestedPids) => { expect(rootPid).toBe(root.pid); requested = requestedPids; return [{ ...worker, ppid: 1 }]; },
    identity: async (pid) => pid === worker.pid ? { ...worker, ppid: 1 } : root,
    alive: (pid) => live.has(pid), signal: (pid, signal) => { signals.push(`${pid}:${signal}`); live.delete(pid); }, port: async () => 'closed' as const, platform: 'win32',
  }, registered: [{ identity: worker, role: 'worker' }] });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(requested).toContain(worker.pid);
  expect(signals).toEqual([`${worker.pid}:SIGTERM`]);
  expect(master.processes.registeredPids).toEqual([]);
  expect(masterLifecycleMapSizes(master.processes, root.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes()).map((key) => [key, 0])));
  expect(await pathExists(fixture.root)).toBeFalse();
  expect(globalCalls).toBe(0);
});

test('Windows replacement identity is released without signalling the replacement', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-replacement-');
  const root: ProcessIdentitySnapshot = { pid: 1_370, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-replacement' };
  const worker: ProcessIdentitySnapshot = { pid: 1_371, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun --worker' };
  const replacement = { ...worker, ppid: 1, startToken: 'replacement' };
  const signals: string[] = [];
  const live = new Set([worker.pid]);
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-replacement', rootMarker: 'owned-replacement', ports: [41_370], ingressPorts: [41_370], rootPorts: [41_370], workerCount: 0, rootExited: true, probes: {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid, requestedPids) => { expect(requestedPids).toContain(worker.pid); return [replacement]; },
    identity: async (pid) => pid === worker.pid ? replacement : root,
    alive: (pid) => live.has(pid), signal: (pid, signal) => { signals.push(`${pid}:${signal}`); live.delete(pid); }, port: async () => 'closed' as const, platform: 'win32',
  }, registered: [{ identity: worker, role: 'worker' }] });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(signals).toEqual([]);
  expect(master.processes.ownsPid(worker.pid)).toBeFalse();
  const independent = new ProcessRegistry({ alive: () => true, requireTestMarker: false });
  expect(independent.registerPid(replacement.pid, replacement, { role: 'worker' })).toBe(replacement.pid);
  independent.release(replacement);
  expect(await pathExists(fixture.root)).toBeFalse();
});

test('public worker wait, ownership sync, and cleanup use only the owned provider on Windows', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-public-chain-');
  const root: ProcessIdentitySnapshot = { pid: 1_380, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-public-chain' };
  const live = new Set([root.pid]);
  let ownedCalls = 0;
  let globalCalls = 0;
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-public-chain', rootMarker: 'owned-public-chain', ports: [41_380], ingressPorts: [41_380], rootPorts: [41_380], workerCount: 0, probes: {
    snapshot: async () => { globalCalls += 1; throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async () => { ownedCalls += 1; return [root]; },
    identity: async () => root, alive: (pid) => live.has(pid), signal: (pid) => { live.delete(pid); }, port: async () => 'closed' as const, platform: 'win32',
  } });
  expect(await waitForWorkerPids(master, 0)).toEqual([]);
  await master.synchronizeOwnership();
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(ownedCalls).toBeGreaterThanOrEqual(3);
  expect(globalCalls).toBe(0);
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
  expect(rootProbes).toBe(2);
  expect(signals).toEqual([]);
});

test('mixed saved mismatch and unknown children release mismatch but retain unknown until retry', async () => {
  const fixture = await createMasterFixture('bungee-harness-mixed-children-');
  const root: ProcessIdentitySnapshot = { pid: 1_180, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=mixed-children' };
  const mismatch: ProcessIdentitySnapshot = { pid: 1_181, ppid: root.pid, startToken: 'old', executable: '/bun', commandLine: 'bun mismatch', testMarker: 'mixed-children' };
  const unknown: ProcessIdentitySnapshot = { pid: 1_182, ppid: root.pid, startToken: 'unknown', executable: '/bun', commandLine: 'bun unknown', testMarker: 'mixed-children' };
  const live = new Set([mismatch.pid, unknown.pid]);
  const signals: string[] = [];
  let now = 0;
  let unknownIdentityCalls = 0;
  const probes = {
    snapshot: async () => [root],
    identity: async (pid: number) => {
      if (pid === mismatch.pid) return { ...mismatch, startToken: 'replacement' };
      if (pid === unknown.pid) return unknownIdentityCalls++ === 0 ? unknown : null;
      return root;
    },
    alive: (pid: number) => live.has(pid),
    liveness: (pid: number) => pid === unknown.pid ? live.has(pid) ? unknownIdentityCalls > 0 ? 'unknown' : 'alive' : 'absent' : live.has(pid) ? 'alive' : 'absent',
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'mixed-children', rootMarker: 'mixed-children', ports: [41_120], ingressPorts: [41_120], rootPorts: [41_120], workerCount: 0, rootExited: true, probes,
    processTiming: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; }, timing: { termWaitMs: 1_500, killWaitMs: 3_000, waitStepMs: 25 } },
    registered: [{ identity: mismatch, role: 'worker' }, { identity: unknown, role: 'worker' }] });
  master.settleRootExit('event', 0, null);
  master.settleRootExit('os_absence', 0, null);
  const wallStart = performance.now();
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toBeInstanceOf(AggregateError);
  expect(now).toBe(4_500);
  expect(performance.now() - wallStart).toBeLessThan(100);
  expect(signals).toEqual([]);
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

test('owned snapshot missing root still returns a reparented child and signals only that child', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-root-missing-');
  const root: ProcessIdentitySnapshot = { pid: 1_183, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-root-missing' };
  const worker: ProcessIdentitySnapshot = { pid: 1_184, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker', testMarker: 'owned-root-missing' };
  const live = new Set([worker.pid]);
  const requested: number[][] = [];
  const signals: string[] = [];
  let ownedCalls = 0;
  const missing = () => new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 1, incomplete_count: 0 }, [ { ...worker, ppid: 1 } ]);
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid: number, pids: readonly number[], expectedRoot?: ProcessIdentitySnapshot, requireRoot?: boolean) => {
      requested.push([...pids]);
      expect(expectedRoot).toBeUndefined();
      expect(requireRoot).toBeFalse();
      ownedCalls += 1;
      if (ownedCalls === 1) throw missing();
      return [{ ...worker, ppid: 1 }];
    },
    identity: async (pid: number) => pid === worker.pid ? { ...worker, ppid: 1 } : root,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : live.has(pid) ? 'alive' as const : 'absent' as const,
    alive: (pid: number) => pid === root.pid ? false : live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const, platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-root-missing', rootMarker: 'owned-root-missing', ports: [41_121], ingressPorts: [41_121], rootPorts: [41_121], workerCount: 0, probes,
    registered: [{ identity: worker, role: 'worker' }], rootExited: true });
  master.settleRootExit('os_absence', 0, null);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(requested).toContainEqual([worker.pid]);
  expect(requested.at(-1)).toEqual([worker.pid]);
  expect(ownedCalls).toBe(2);
  expect(signals).toEqual([`${worker.pid}:SIGTERM`]);
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
  expect(masterLifecycleMapSizes(master.processes, root.pid)).toEqual(Object.fromEntries(Object.keys(masterLifecycleMapSizes(master.processes, root.pid)).map((key) => [key, 0])));
});

test('owned snapshot partial replacement releases only the old owner and never signals', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-partial-replacement-');
  const root: ProcessIdentitySnapshot = { pid: 1_192, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-partial-replacement' };
  const worker: ProcessIdentitySnapshot = { pid: 1_193, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker' };
  const replacement = { ...worker, startToken: 'replacement' };
  const signals: string[] = [];
  let ownedCalls = 0;
  const requested: number[][] = [];
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid: number, pids: readonly number[]) => {
      ownedCalls += 1;
      requested.push([...pids]);
      if (ownedCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 1, incomplete_count: 0 }, [replacement]);
      if (ownedCalls === 2) return [replacement];
      return [];
    },
    identity: async (pid: number) => pid === worker.pid ? replacement : root,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : 'alive' as const,
    alive: (pid: number) => pid !== root.pid,
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const,
    platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-partial-replacement', rootMarker: 'owned-partial-replacement', ports: [41_192], ingressPorts: [41_192], workerCount: 0, rootExited: true, probes,
    registered: [{ identity: worker, role: 'worker' }] });
  try {
    let failure: unknown;
    try { await cleanupMaster(master, [], { fixture, expectGraceful: false }); }
    catch (error) { failure = error; }
    expect(failure).toBeDefined();
    expect(isRetryableOwnedSnapshotObservation(failure)).toBeTrue();
    expect((failure as Error).message).toBe('owned snapshot recovery failed closed');
    expect((failure as Error).cause).toBeUndefined();
    Object.defineProperty(failure as object, 'cause', { configurable: true, get: () => { throw new Error('cause must not be read'); } });
    expect(isRetryableOwnedSnapshotObservation(failure)).toBeTrue();
    expect((failure as Error).message).not.toContain('bun worker');
    expect(isRetryableOwnedSnapshotObservation({ message: 'reason=missing' })).toBeFalse();
    expect(ownedSnapshotObservationEvidence(failure, 'retry')).toEqual({
      operation: 'owned_snapshot', poll_attempt: 'retry', reason: 'missing', root_returned: false,
      requested_total: 1, returned: 1, incomplete_count: 0,
    });
    const spoof = Object.assign(new Error('owned snapshot recovery failed closed'), { name: 'CleanupCoverageFailClosedError' });
    expect(isRetryableOwnedSnapshotObservation(spoof)).toBeFalse();
    expect(ownedSnapshotObservationEvidence(spoof, 'retry')).toBeNull();
    expect(ownedCalls).toBe(2);
    expect(requested).toEqual([[worker.pid], []]);
    expect(signals).toEqual([]);
    expect(master.processes.ownsPid(worker.pid)).toBeFalse();
    const replacementOwner = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
    expect(replacementOwner.registerPid(replacement.pid, replacement, { role: 'worker' })).toBe(replacement.pid);
    replacementOwner.release(replacement);
    await cleanupMaster(master, [], { fixture, expectGraceful: false });
  } finally {
    if (await pathExists(fixture.root)) {
      master.settleRootExit('os_absence', null, null);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    }
  }
});

test('owned snapshot partial mismatch waits for fresh old-exact identity before strict retry', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-partial-stale-');
  const root: ProcessIdentitySnapshot = { pid: 1_196, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-partial-stale' };
  const worker: ProcessIdentitySnapshot = { pid: 1_197, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker' };
  const partialReplacement = { ...worker, startToken: 'partial-replacement' };
  const live = new Set([worker.pid]);
  const requested: number[][] = [];
  const signals: string[] = [];
  let ownedCalls = 0;
  let ownerWasRetained = false;
  let now = 0;
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid: number, pids: readonly number[], expectedRoot?: ProcessIdentitySnapshot, requireRoot?: boolean) => {
      ownedCalls += 1;
      requested.push([...pids]);
      expect(expectedRoot).toBeUndefined();
      expect(requireRoot).toBeFalse();
      if (ownedCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 1, incomplete_count: 0 }, [partialReplacement]);
      ownerWasRetained = master.processes.ownsPid(worker.pid);
      return [worker];
    },
    identity: async (pid: number) => pid === worker.pid ? worker : root,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : live.has(pid) ? 'alive' as const : 'absent' as const,
    alive: (pid: number) => pid !== root.pid,
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
    platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-partial-stale', rootMarker: 'owned-partial-stale', ports: [41_196], ingressPorts: [41_196], workerCount: 0, rootExited: true, probes,
    processTiming: { now: () => now, sleep: async (milliseconds) => { now += milliseconds; }, timing: { termWaitMs: 1_500, killWaitMs: 3_000, waitStepMs: 25 } },
    registered: [{ identity: worker, role: 'worker' }] });
  master.settleRootExit('os_absence', 0, null);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(ownerWasRetained).toBeTrue();
  expect(requested).toEqual([[worker.pid], [worker.pid]]);
  expect(ownedCalls).toBe(2);
  expect(signals).toEqual([`${worker.pid}:SIGTERM`]);
  expect(await pathExists(fixture.root)).toBeFalse();
});

test('generic owned snapshot recovery builds a partial or target-only baseline and retries strictly', async () => {
  const root: ProcessIdentitySnapshot = { pid: 1_198, ppid: 1, startToken: 'root', executable: 'C:\\bun.exe', commandLine: 'bun root' };
  const child: ProcessIdentitySnapshot = { pid: 1_199, ppid: root.pid, startToken: 'child', executable: 'C:\\bun.exe', commandLine: 'bun child' };
  const requested: number[][] = [];
  const ownedChildren = new Set([child.pid]);
  let ownedCalls = 0;
  const result = await __testCaptureOwnedSnapshotSafely({
    rootPid: root.pid,
    expectedRoot: root,
    ownedSnapshot: async (_rootPid, pids, expected, requireRoot) => {
      ownedCalls += 1;
      requested.push([...pids]);
      if (ownedCalls === 1) {
        expect(expected).toEqual(root);
        expect(requireRoot).toBeTrue();
        throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 0, returned_count: 1, incomplete_count: 0 }, [child]);
      }
      expect(expected).toBeUndefined();
      expect(requireRoot).toBeFalse();
      return [child];
    },
    identity: async (pid) => pid === child.pid ? child : null,
    liveness: (pid) => pid === root.pid ? 'absent' : ownedChildren.has(pid) ? 'alive' : 'absent',
  });
  expect(ownedCalls).toBe(2);
  expect(requested).toEqual([[], [child.pid]]);
  expect(result).toEqual([child]);
  expect(ownedChildren).toEqual(new Set([child.pid]));

  const target: ProcessIdentitySnapshot = { pid: 1_200, ppid: root.pid, startToken: 'target', executable: 'C:\\bun.exe', commandLine: 'bun target' };
  let targetCalls = 0;
  const targetRequested: number[][] = [];
  const targetResult = await __testCaptureOwnedSnapshotSafely({
    rootPid: root.pid,
    requestedPids: [target.pid],
    requireRoot: false,
    ownedSnapshot: async (_rootPid, pids, expected, requireRoot) => {
      targetCalls += 1;
      targetRequested.push([...pids]);
      expect(expected).toBeUndefined();
      expect(requireRoot).toBeFalse();
      if (targetCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 0, incomplete_count: 0 });
      return [target];
    },
    identity: async (pid) => pid === target.pid ? target : null,
    liveness: (pid) => pid === target.pid ? 'alive' : 'absent',
  });
  expect(targetCalls).toBe(2);
  expect(targetRequested).toEqual([[target.pid], [target.pid]]);
  expect(targetResult).toEqual([target]);
});

test('generic strict retry fails closed for a PID outside the fresh baseline', async () => {
  const root: ProcessIdentitySnapshot = { pid: 1_201, ppid: 1, startToken: 'root', executable: 'C:\\bun.exe', commandLine: 'bun root' };
  const child: ProcessIdentitySnapshot = { pid: 1_202, ppid: root.pid, startToken: 'child', executable: 'C:\\bun.exe', commandLine: 'bun child' };
  const replacement: ProcessIdentitySnapshot = { pid: 1_203, ppid: root.pid, startToken: 'replacement', executable: 'C:\\bun.exe', commandLine: 'bun replacement' };
  const requested: number[][] = [];
  let ownedCalls = 0;
  let failure: unknown;
  try {
    await __testCaptureOwnedSnapshotSafely({
      rootPid: root.pid,
      requestedPids: [child.pid],
      expectedRoot: root,
      requireRoot: false,
      ownedSnapshot: async (_rootPid, pids, expected, requireRoot) => {
        ownedCalls += 1;
        requested.push([...pids]);
        expect(expected).toBeUndefined();
        expect(requireRoot).toBeFalse();
        if (ownedCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 0, incomplete_count: 0 });
        return [child, replacement];
      },
      identity: async (pid) => pid === child.pid ? child : null,
      liveness: (pid) => pid === child.pid ? 'alive' : 'absent',
    });
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).not.toContain('bun replacement');
  expect(ownedCalls).toBe(2);
  expect(requested).toEqual([[child.pid], [child.pid]]);
});

test('owned snapshot recovery fails closed on unknown targeted liveness', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-unknown-');
  const root: ProcessIdentitySnapshot = { pid: 1_194, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-unknown' };
  const worker: ProcessIdentitySnapshot = { pid: 1_195, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker' };
  let workerState: 'unknown' | 'absent' = 'unknown';
  let workerLivenessCalls = 0;
  let ownedCalls = 0;
  const signals: string[] = [];
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async () => { ownedCalls += 1; if (ownedCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 1, incomplete_count: 0 }, [{ ...worker, startToken: 'partial-replacement' }]); return []; },
    identity: async () => worker,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : workerLivenessCalls++ === 0 ? 'alive' as const : workerState,
    alive: (pid: number) => pid !== root.pid && workerState !== 'absent',
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const,
    platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-unknown', rootMarker: 'owned-unknown', ports: [41_194], ingressPorts: [41_194], workerCount: 0, rootExited: true, probes,
    registered: [{ identity: worker, role: 'worker' }] });
  try {
    await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow();
    expect(ownedCalls).toBe(1);
    expect(signals).toEqual([]);
    expect(master.processes.ownsPid(worker.pid)).toBeTrue();
    workerState = 'absent';
    await cleanupMaster(master, [], { fixture, expectGraceful: false });
  } finally {
    if (master.processes.registeredPids.length > 0) {
      workerState = 'absent';
      master.settleRootExit('os_absence', null, null);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    }
  }
});

test.each([
  ['liveness unknown', 'liveness', 1_205, 41_205] as const,
  ['second strict parse_error', 'parse_error', 1_215, 41_215] as const,
  ['second strict root_mismatch', 'root_mismatch', 1_225, 41_225] as const,
])('real cleanup wrapper fails closed for %s', async (_label, failureKind, rootPid, port) => {
  const fixture = await createMasterFixture(`bungee-harness-wrapper-${failureKind}-`);
  const root: ProcessIdentitySnapshot = { pid: rootPid, ppid: 1, startToken: 'root', executable: 'C:\\bun.exe', commandLine: `bun --bungee-test-root-marker=wrapper-${failureKind}` };
  const worker: ProcessIdentitySnapshot = { pid: rootPid + 1, ppid: root.pid, startToken: 'worker', executable: 'C:\\bun.exe', commandLine: 'bun worker' };
  let workerState: 'alive' | 'absent' = 'alive';
  let workerLivenessCalls = 0;
  let ownedCalls = 0;
  const signals: string[] = [];
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid: number, requestedPids: readonly number[]) => {
      ownedCalls += 1;
      if (workerState === 'absent') return [];
      if (ownedCalls === 1) {
        expect(requestedPids).toEqual([worker.pid]);
        throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid,
          requested_count: 1, returned_count: 0, incomplete_count: 0 });
      }
      if (failureKind === 'parse_error') {
        throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'parse_error', last_phase: 'serialize', root_pid: root.pid,
          requested_count: 1, returned_count: 0, incomplete_count: 0 });
      }
      if (failureKind === 'root_mismatch') {
        throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'root_mismatch', last_phase: 'serialize', root_pid: root.pid,
          requested_count: 1, returned_count: 1, incomplete_count: 0 });
      }
      return [];
    },
    identity: async (pid: number) => pid === worker.pid ? worker : root,
    liveness: (pid: number) => {
      if (pid === root.pid) return 'absent' as const;
      if (workerState === 'absent') return 'absent' as const;
      if (failureKind === 'liveness' && workerLivenessCalls++ > 0) return 'unknown' as const;
      return 'alive' as const;
    },
    alive: (pid: number) => pid !== root.pid && workerState === 'alive',
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); workerState = 'absent'; },
    port: async () => 'closed' as const,
    platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: `wrapper-${failureKind}`, rootMarker: `wrapper-${failureKind}`,
    ports: [port], ingressPorts: [port], workerCount: 0, rootExited: true, probes,
    registered: [{ identity: worker, role: 'worker' }] });
  try {
    let failure: unknown;
    try { await cleanupMaster(master, [], { fixture, expectGraceful: false }); }
    catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).name).toBe('CleanupCoverageFailClosedError');
    expect(isRetryableOwnedSnapshotObservation(failure)).toBeFalse();
    expect(ownedSnapshotObservationEvidence(failure, 'retry')).toBeNull();
    expect(signals).toEqual([]);
    expect(ownedCalls).toBe(failureKind === 'liveness' ? 1 : 2);
  } finally {
    workerState = 'absent';
    await cleanupMaster(master, [], { fixture, expectGraceful: false });
  }
});

test('owned snapshot exact targeted retry succeeds without consulting a global snapshot', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-retry-');
  const root: ProcessIdentitySnapshot = { pid: 1_185, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-retry' };
  const worker: ProcessIdentitySnapshot = { pid: 1_186, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker', testMarker: 'owned-retry' };
  let calls = 0;
  const live = new Set([worker.pid]);
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async () => { calls += 1; if (calls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 0, incomplete_count: 0 }); return [worker]; },
    identity: async (pid: number) => pid === worker.pid ? worker : root,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : live.has(pid) ? 'alive' as const : 'absent' as const,
    alive: (pid: number) => pid === root.pid ? false : live.has(pid), signal: (pid: number) => { live.delete(pid); }, port: async () => 'closed' as const, platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-retry', rootMarker: 'owned-retry', ports: [41_122], ingressPorts: [41_122], rootPorts: [41_122], workerCount: 0, probes,
    registered: [{ identity: worker, role: 'worker' }], rootExited: true });
  master.settleRootExit('os_absence', 0, null);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(calls).toBe(2);
  expect(await pathExists(fixture.root)).toBeFalse();
});

test('owned requested reparent disappears and is accepted as an absent old child without signalling', async () => {
  const fixture = await createMasterFixture('bungee-harness-owned-reparent-');
  const root: ProcessIdentitySnapshot = { pid: 1_187, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=owned-reparent' };
  const worker: ProcessIdentitySnapshot = { pid: 1_188, ppid: root.pid, startToken: 'worker', executable: '/bun', commandLine: 'bun worker', testMarker: 'owned-reparent' };
  let state: 'alive' | 'absent' = 'alive';
  const requested: number[][] = [];
  const signals: string[] = [];
  let ownedCalls = 0;
  const probes = {
    snapshot: async () => { throw new Error('global snapshot must not be called'); },
    ownedSnapshot: async (_rootPid: number, pids: readonly number[]) => { requested.push([...pids]); state = 'absent'; ownedCalls += 1; if (ownedCalls === 1) throw new WindowsOwnedSnapshotError({ operation: 'owned_snapshot', reason: 'missing', last_phase: 'serialize', root_pid: root.pid, requested_count: 1, returned_count: 0, incomplete_count: 0 }); return []; },
    identity: async () => worker,
    liveness: (pid: number) => pid === root.pid ? 'absent' as const : state,
    alive: (pid: number) => pid !== root.pid && state === 'alive', signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${pid}:${signal}`),
    port: async () => 'closed' as const, platform: 'win32' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'owned-reparent', rootMarker: 'owned-reparent', ports: [41_123], ingressPorts: [41_123], rootPorts: [41_123], workerCount: 0, probes,
    registered: [{ identity: worker, role: 'worker' }], rootExited: true });
  master.settleRootExit('os_absence', 0, null);
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(requested).toContainEqual([worker.pid]);
  expect(signals).toEqual([]);
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
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
  expect(master.rootExitState).toMatchObject({ exited: true, code: 0, signal: null, confirmedBy: 'os_absence', eventObserved: true });
  expect(rootProbes).toBe(2);
  expect(signals).toEqual([]);
});

test('graceful cleanup requires a clean handle outcome and accepts final OS absence', async () => {
  const fixture = await createMasterFixture('bungee-harness-graceful-clean-');
  const root: ProcessIdentitySnapshot = { pid: 11_152, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=graceful-clean' };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'graceful-clean', rootMarker: 'graceful-clean', ports: [41_012], ingressPorts: [41_012], workerCount: 0,
    rootExited: true, probes: { snapshot: async () => [root], identity: async () => root, alive: () => false, port: async () => 'closed' as const, signal: () => {} } });
  await cleanupMaster(master, [], { fixture, expectGraceful: true });
  expect(master.rootExitState).toMatchObject({ eventObserved: true, eventCode: 0, eventSignal: null, confirmedBy: 'os_absence' });
});

test('graceful cleanup rejects final absence without a clean handle event', async () => {
  const fixture = await createMasterFixture('bungee-harness-graceful-no-event-');
  const root: ProcessIdentitySnapshot = { pid: 11_153, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=graceful-no-event' };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'graceful-no-event', rootMarker: 'graceful-no-event', ports: [41_013], ingressPorts: [41_013], workerCount: 0,
    probes: { snapshot: async () => [root], identity: async () => root, alive: () => false, port: async () => 'closed' as const, signal: () => {} } });
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: true })).rejects.toBeInstanceOf(AggregateError);
});

test.each([
  ['nonzero exit', 1, null], ['signal exit', 0, 'SIGTERM'],
] as const)('graceful cleanup rejects %s handle evidence', async (_label, code, signal) => {
  const fixture = await createMasterFixture(`bungee-harness-graceful-${_label.replace(' ', '-')}-`);
  const root: ProcessIdentitySnapshot = { pid: code === 1 ? 11_154 : 11_155, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=graceful-bad-handle' };
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'graceful-bad-handle', rootMarker: 'graceful-bad-handle', ports: [41_014], ingressPorts: [41_014], workerCount: 0,
    rootExited: true, probes: { snapshot: async () => [root], identity: async () => root, alive: () => false, port: async () => 'closed' as const, signal: () => {} } });
  master.settleRootExit('event', code, signal);
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: true })).rejects.toBeInstanceOf(AggregateError);
});

test.each(['unknown', 'alive'] as const)('graceful cleanup fails closed for an exact root that is %s', async (mode) => {
  const fixture = await createMasterFixture(`bungee-harness-graceful-${mode}-`);
  const root: ProcessIdentitySnapshot = { pid: mode === 'unknown' ? 11_156 : 11_157, ppid: 1, startToken: mode, executable: '/bun', commandLine: `--bungee-test-root-marker=graceful-${mode}` };
  const master = createFakeRunningMaster({ fixture, root, testMarker: `graceful-${mode}`, rootMarker: `graceful-${mode}`, ports: [41_016], ingressPorts: [41_016], workerCount: 0,
    probes: { snapshot: async () => [root], identity: async () => root, alive: () => true, liveness: () => mode === 'unknown' ? 'unknown' as const : 'alive' as const,
      port: async () => 'closed' as const, signal: () => {} } });
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: true })).rejects.toBeDefined();
}, 10_000);

test('cleanupMaster keeps an exact live root through stale events and then kills it', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-term-kill-');
  const root: ProcessIdentitySnapshot = { pid: 1_155, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=term-kill' };
  const live = new Set([root.pid]);
  const signals: string[] = [];
  let master!: ReturnType<typeof createFakeRunningMaster>;
  master = createFakeRunningMaster({ fixture, root, testMarker: 'term-kill', rootMarker: 'term-kill', ports: [41_005], ingressPorts: [41_005], rootPorts: [41_005], workerCount: 0,
    probes: {
      snapshot: async () => [root], identity: async () => root, alive: (pid) => live.has(pid),
      signal: (pid, signal) => {
        signals.push(signal);
        (master.child as unknown as { signalCode: NodeJS.Signals | null }).signalCode = signal;
        master.settleRootExit('event', null, signal);
        if (signal === 'SIGTERM') {
          expect(master.rootExitState.exited).toBeFalse();
          expect(master.processes.ownsPid(root.pid)).toBeTrue();
        } else {
          live.delete(pid);
        }
      }, port: async () => 'closed' as const,
    } });
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect((master.child as unknown as { signalCode: NodeJS.Signals | null }).signalCode).toBe('SIGKILL');
  expect(master.rootExitState.confirmedBy).toBe('os_absence');
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
});

test('an exit event with unknown liveness preserves ownership and fixture', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-unknown-event-');
  const root: ProcessIdentitySnapshot = { pid: 1_156, ppid: 1, startToken: 'root', executable: '/bun', commandLine: '--bungee-test-root-marker=unknown-event' };
  let mode: 'unknown' | 'absent' = 'unknown';
  const signals: string[] = [];
  const master = createFakeRunningMaster({ fixture, root, testMarker: 'unknown-event', rootMarker: 'unknown-event', ports: [41_006], ingressPorts: [41_006], rootPorts: [41_006], workerCount: 0,
    probes: {
      snapshot: async () => [root], identity: async () => root, alive: () => mode === 'unknown', liveness: () => mode === 'unknown' ? 'unknown' : 'absent',
      signal: (_pid, signal) => signals.push(signal), port: async () => 'closed' as const,
    } });
  master.settleRootExit('event', null, 'SIGTERM');
  await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow();
  expect(master.processes.ownsPid(root.pid)).toBeTrue();
  expect(await pathExists(fixture.root)).toBeTrue();
  expect(signals).toEqual([]);
  mode = 'absent';
  await cleanupMaster(master, [], { fixture, expectGraceful: false });
  expect(master.processes.registeredPids).toEqual([]);
  expect(await pathExists(fixture.root)).toBeFalse();
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
  expect(rootProbes).toBe(2);
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

test('builds a PID-scoped Windows WMI child query', () => {
  const command = windowsChildPidsCommand(1234);
  expect(command).toContain('[System.Management.ManagementObjectSearcher]');
  expect(command).toContain('ParentProcessId = 1234');
  expect(command).not.toContain('Get-CimInstance');
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
    const diagnostics = workerObservationDiagnostics(masterA, new Set(), [rootB]);
    expect(diagnostics).toContain(`root_identity_mismatch_fields=${rootIdentityMismatchFields(rootA, rootB).join(',')}`);
    expect(diagnostics).toContain('descriptor_read_outcome=missing descriptor_current_count=0 descriptor_current_sha256=');
    expect(diagnostics).toContain('descriptor_saved_count=0 descriptor_saved_sha256=');
    expect(diagnostics).toContain('registration_source=unknown');
    expect(signals).toEqual([]);
  } finally {
    await cleanupSpawnedProcesses(scopeA);
    await cleanupSpawnedProcesses(scopeB);
  }
});

test('records root proof writers and rejects a late monitor write after stop', () => {
  const scope = createMasterCleanupScope();
  const registry = new ProcessRegistry({ alive: () => false });
  const first: ProcessIdentitySnapshot = { pid: 50_300, ppid: 1, startToken: 'a', executable: '/bun', commandLine: 'bun root' };
  const second = { ...first, startToken: 'b' };
  writeRootProof(registry, first, 'spawn', scope, 'master-a', 'running');
  writeRootProof(registry, second, 'ownership_sync', scope, 'master-a', 'stopped', true);
  const records = rootProofWriteEvidence(registry);
  expect(records.map(({ proof_source, proof_write_sequence, monitor_state }) => ({ proof_source, proof_write_sequence, monitor_state }))).toEqual([
    { proof_source: 'spawn', proof_write_sequence: 1, monitor_state: 'running' },
    { proof_source: 'ownership_sync', proof_write_sequence: 2, monitor_state: 'stopped' },
  ]);
  expect(records.every(({ scope_id, master_id, proof_fingerprint }) => scope_id === scope.scopeId && master_id === 'master-a' && /^[0-9a-f]{64}$/u.test(proof_fingerprint))).toBeTrue();
  expect(() => writeRootProof(registry, first, 'monitor_snapshot', scope, 'master-a', 'stopped')).toThrow('late root proof write rejected after monitor stop');
  expect(rootProofWriteEvidence(registry)).toEqual(records);
});

test('atomically commits two current descriptors over an empty saved proof, then leaves zero partial state on failure', async () => {
  const fixture = await createMasterFixture('bungee-harness-atomic-ownership-');
  const marker = 'atomic-ownership';
  const root: ProcessIdentitySnapshot = { pid: 50_310, ppid: 1, startToken: 'root', executable: '/bun',
    commandLine: `bun --bungee-test-root-marker=${marker}`, testMarker: marker };
  const worker = (pid: number, instance: string, slot: number): ProcessIdentitySnapshot => ({
    pid, ppid: root.pid, startToken: `worker-${slot}`, executable: '/bun',
    commandLine: `bun --bungee-process-identity=${instance}`, testMarker: marker, roleMarker: 'worker',
  });
  const workers = [
    worker(50_311, '53100000-0000-4000-8000-000000000001', 0),
    worker(50_312, '53100000-0000-4000-8000-000000000002', 1),
  ];
  const ingress: ProcessIdentitySnapshot = { pid: 50_313, ppid: root.pid, startToken: 'ingress', executable: '/bun',
    commandLine: 'bun --bungee-process-identity=53100000-0000-4000-8000-000000000003', testMarker: marker, roleMarker: 'ingress' };
  const generation = '53100000-0000-4000-8000-000000000010';
  const bootNonce = '53100000-0000-4000-8000-000000000011';
  const descriptors = workers.map((identity, slot) => {
    const instance = identity.commandLine.split('=')[1]!;
    const credential = deriveWorkerSupervisionCredential(
      deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, slot), bootNonce,
    );
    return signWorkerDescriptor({
      schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: generation,
      worker_instance_id: instance, worker_slot: slot, boot_nonce: bootNonce, pid: identity.pid,
      control_port: 41_001 + slot, phase: 'serving', frozen: false, private_port: 41_011 + slot, revision: 1,
      content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      started_at: 1, evidence: { kind: 'candidate' },
    }, credential.process_key);
  });
  const directory = workerDescriptorsDirectory(fixture);
  await mkdir(directory, { recursive: true });
  await Promise.all(descriptors.map((descriptor) => writeFile(join(directory, `${descriptor.worker_instance_id}.json`), `${JSON.stringify(descriptor)}\n`)));
  let snapshot: readonly ProcessIdentitySnapshot[] = [root, ...workers, ingress];
  const live = new Set(snapshot.map(({ pid }) => pid));
  const signals: string[] = [];
  const probes = {
    snapshot: async () => snapshot,
    identity: async (pid: number) => snapshot.find((identity) => identity.pid === pid) ?? null,
    alive: (pid: number) => live.has(pid),
    signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => { signals.push(`${pid}:${signal}`); live.delete(pid); },
    port: async () => 'closed' as const,
  };
  const master = createFakeRunningMaster({ fixture, root, testMarker: marker, rootMarker: marker,
    ports: [41_000, 41_001, 41_002], ingressPorts: [41_001, 41_002], workerCount: 2, probes });
  try {
    const initialHistory = rootProofWriteEvidence(master.processes);
    snapshot = [root, workers[0]!, ingress];
    await expect(master.synchronizeOwnership()).rejects.toThrow('worker descriptor PID 50312 is not exact');
    expect(rootProofWriteEvidence(master.processes)).toEqual(initialHistory);
    expect(master.processes.registeredPids).toEqual([root.pid]);
    snapshot = [root, ...workers, ingress];
    await master.synchronizeOwnership();
    expect(master.processes.registeredProcesses.map(({ pid }) => pid)).toEqual([root.pid, workers[0]!.pid, workers[1]!.pid, ingress.pid]);
    const committedHistory = rootProofWriteEvidence(master.processes);
    expect(committedHistory.at(-1)?.proof_source).toBe('ownership_sync');
    snapshot = [root, workers[0]!, ingress];
    await expect(master.synchronizeOwnership()).rejects.toThrow('worker descriptor PID 50312 is not exact');
    expect(rootProofWriteEvidence(master.processes)).toEqual(committedHistory);
    expect(master.processes.registeredPids).toEqual([root.pid, workers[0]!.pid, workers[1]!.pid, ingress.pid]);
    expect(signals).toEqual([]);
  } finally {
    snapshot = [root, ...workers, ingress];
    live.clear();
    await cleanupMaster(master, [], { fixture, expectGraceful: false, probePort: probes.port });
  }
});

test('restores descriptor backups once per path after removing tampered directories', async () => {
  const fixture = await createMasterFixture('bungee-harness-descriptor-backup-');
  const path = join(fixture.root, 'descriptor.json');
  const backup = `${path}.backup`;
  try {
    await writeFile(backup, 'restored\n');
    await mkdir(path);
    await restoreDescriptorBackups([{ path, backup }, { path, backup }], [path, path]);
    expect(await readFile(path, 'utf8')).toBe('restored\n');
    expect(await pathExists(backup)).toBeFalse();
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test('skips a missing backup and restores the only valid backup', async () => {
  const fixture = await createMasterFixture('bungee-harness-descriptor-backup-missing-');
  const path = join(fixture.root, 'descriptor.json');
  const missing = `${path}.missing.backup`;
  const valid = `${path}.valid.backup`;
  try {
    await writeFile(valid, 'restored\n');
    await mkdir(path);
    await restoreDescriptorBackups([{ path, backup: missing }, { path, backup: valid }], [path]);
    expect(await readFile(path, 'utf8')).toBe('restored\n');
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('fails closed on multiple valid descriptor backups before removing the tampered path', async () => {
  const fixture = await createMasterFixture('bungee-harness-descriptor-backup-multiple-');
  const path = join(fixture.root, 'descriptor.json');
  const first = `${path}.first.backup`;
  const second = `${path}.second.backup`;
  try {
    await writeFile(first, 'first\n');
    await writeFile(second, 'second\n');
    await mkdir(path);
    await expect(restoreDescriptorBackups([{ path, backup: first }, { path, backup: second }], [path])).rejects
      .toThrow('multiple valid copies');
    expect((await stat(path)).isDirectory()).toBeTrue();
  } finally { await rm(fixture.root, { recursive: true, force: true }); }
});

test('root mismatch evidence reports only the changed identity field', () => {
  const expected: ProcessIdentitySnapshot = { pid: 50_301, ppid: 1, startToken: 'start', executable: '/bun', commandLine: 'bun root', roleMarker: 'root', testMarker: 'test' };
  expect(rootIdentityMismatchFields(expected, { ...expected, startToken: 'replacement' })).toEqual(['start_token']);
  const markerOnly = { ...expected, roleMarker: 'other-role', testMarker: 'other-test' };
  expect(rootIdentityMismatchFields(expected, markerOnly, 'win32')).toEqual([]);
});

test('descriptor read errors distinguish validation from I/O failures', () => {
  expect(classifyDescriptorReadError(new SyntaxError('invalid JSON'))).toBe('parse_error');
  expect(classifyDescriptorReadError(new SupervisionProtocolError('invalid_mac', 'bad signature'))).toBe('parse_error');
  for (const code of ['EACCES', 'EIO', 'ETIMEDOUT', 'UNKNOWN']) {
    expect(classifyDescriptorReadError(Object.assign(new Error('descriptor read failed'), { code }))).toBe('read_error');
  }
});

test('phase budget aborts the phase, enters cleanup, and leaves no pending wait', async () => {
  let fireTimeout!: () => void;
  let cleanupCalls = 0;
  let phaseAborted = false;
  let cleanupStarted = false;
  let pending = 0;
  let cleanupRemaining = 0;
  let resolveCleanup!: () => void;
  const budget = createTestPhaseBudget(100, () => 0, {
    cleanupReserveMs: 50,
    schedule: (callback) => { fireTimeout = callback; return 0; },
    cancel: () => {},
  });
  let failure: unknown;
  try {
    await runWithCleanup(
      () => budget.run('health', async (signal) => {
        await new Promise<void>((_, reject) => {
          signal.addEventListener('abort', () => { phaseAborted = true; reject(signal.reason); }, { once: true });
          queueMicrotask(() => fireTimeout());
        });
      }),
      async () => {
        cleanupCalls += 1;
        const cleanupPromise = budget.runCleanup('cleanup', async (_signal, remainingMs) => {
          cleanupStarted = true;
          cleanupRemaining = remainingMs;
          pending += 1;
          await new Promise<void>((resolve) => { resolveCleanup = resolve; });
          pending -= 1;
          throw new Error('cleanup result: completed');
        });
        resolveCleanup();
        await cleanupPromise;
      },
    );
  } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(AggregateError);
  expect((failure as AggregateError).errors[0]).toHaveProperty('message', 'phase budget exhausted: health');
  expect((failure as AggregateError).errors[1]).toHaveProperty('message', 'cleanup result: completed');
  expect(phaseAborted).toBeTrue();
  expect(cleanupCalls).toBe(1);
  expect(cleanupStarted).toBeTrue();
  expect(cleanupRemaining).toBe(100);
  expect(pending).toBe(0);
});

test('reserves the cleanup window from a deterministic absolute deadline', async () => {
  let now = 0;
  let bodyRemaining = 0;
  let cleanupRemaining = 0;
  const budget = createTestPhaseBudget(100, () => now, { cleanupReserveMs: 30 });
  await budget.run('body', async (_signal, remainingMs) => { bodyRemaining = remainingMs; });
  expect(bodyRemaining).toBe(70);
  now = 70;
  await budget.runCleanup('cleanup', async (_signal, remainingMs) => { cleanupRemaining = remainingMs; });
  expect(cleanupRemaining).toBe(30);
});

test('cleanup deadline waits for the pending cleanup promise to drain before rejecting', async () => {
  let now = 0;
  let fireDeadline!: () => void;
  let resolveCleanup!: () => void;
  let pending = 0;
  let settled = false;
  const budget = createTestPhaseBudget(100, () => now, {
    cleanupReserveMs: 30,
    schedule: (callback) => { fireDeadline = callback; return 0; },
    cancel: () => {},
  });
  const cleanup = budget.runCleanup('cleanup', async () => {
    pending += 1;
    await new Promise<void>((resolve) => { resolveCleanup = resolve; });
    pending -= 1;
  }).finally(() => { settled = true; });
  await Promise.resolve();
  now = 100;
  fireDeadline();
  await Promise.resolve();
  expect(settled).toBeFalse();
  expect(pending).toBe(1);
  resolveCleanup();
  await expect(cleanup).rejects.toThrow('phase budget exhausted: cleanup');
  expect(pending).toBe(0);
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
  let now = 0;
  const captureCalls: string[] = [];
  const signals: string[] = [];
  const handle: { pid: number; exitCode: number | null; signalCode: string | null; kill: () => void } = {
    pid: root.pid, exitCode: null, signalCode: null, kill: () => { alive = false; },
  };
  const registry = new ProcessRegistry({ platform: 'win32', requireTestMarker: false, alive: () => alive,
    now: () => now, sleep: async (milliseconds) => { now += milliseconds; },
    timing: { termWaitMs: 1_500, killWaitMs: 3_000, waitStepMs: 25 },
    liveness: () => captureCalls.length === 0 ? 'alive' : 'unknown',
    captureIdentity: async () => { captureCalls.push('identity'); return null; },
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
  const wallStart = performance.now();
  await expect(cleanupProcesses(registry)).rejects.toBeInstanceOf(AggregateError);
  expect(now).toBe(4_500);
  expect(performance.now() - wallStart).toBeLessThan(100);
  expect(captureCalls.length).toBeGreaterThan(0);
  expect(registry.registeredPids).toEqual([root.pid]);
  expect(signals).toEqual([]);
  expect(registry.releaseHandle(handle)).toBeTrue();
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

test('monitor capture registers only after a stable direct root proof', async () => {
  for (const stable of [true, false]) {
    const fixture = await createMasterFixture(`bungee-harness-monitor-${stable ? 'stable' : 'missing'}-`);
    const generation = '54000000-0000-4000-8000-000000000010';
    const bootNonce = '54000000-0000-4000-8000-000000000011';
    const workerInstances = ['54000000-0000-4000-8000-000000000001', '54000000-0000-4000-8000-000000000002'] as const;
    let master: RunningMaster | undefined;
    let snapshot: readonly ProcessIdentitySnapshot[] = [];
    const writeDescriptors = async (): Promise<void> => {
      const directory = workerDescriptorsDirectory(fixture);
      await mkdir(directory, { recursive: true });
      await Promise.all(workerInstances.map((instance, slot) => {
        const credential = deriveWorkerSupervisionCredential(
          deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, slot), bootNonce,
        );
        const descriptor = signWorkerDescriptor({
          schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: generation,
          worker_instance_id: instance, worker_slot: slot, boot_nonce: bootNonce, pid: 54_011 + slot,
          control_port: 54_021 + slot, phase: 'serving', frozen: false, private_port: 54_031 + slot, revision: 1,
          content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          started_at: 1, evidence: { kind: 'candidate' },
        }, credential.process_key);
        return writeFile(join(directory, `${instance}.json`), `${JSON.stringify(descriptor)}\n`);
      }));
    };
    if (stable) await writeDescriptors();
    const captureIdentity = async (pid: number): Promise<ProcessIdentitySnapshot | null> => {
      if (!stable || master === undefined || pid !== master.child.pid) return null;
      const root = snapshot.find((identity) => identity.pid === pid);
      return root ?? null;
    };
    const captureSnapshot = async (): Promise<readonly ProcessIdentitySnapshot[]> => snapshot;
    const entry = { name: 'source' as const, executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] };
    master = spawnMaster(cleanupScope, entry, fixture, await freePort(cleanupScope), 2, fixture.root, fixture.accessDbPath, {}, {
      captureProcessIdentity: captureIdentity, captureProcessSnapshot: captureSnapshot,
    });
    const root = (): ProcessIdentitySnapshot => ({
      pid: master!.child.pid!, ppid: 1, startToken: 'monitor-root', executable: process.execPath,
      commandLine: `bun --bungee-test-root-marker=${master!.rootMarker}`, testMarker: master!.testMarker,
    });
    const workers: readonly ProcessIdentitySnapshot[] = workerInstances.map((instance, slot) => ({
      pid: 54_011 + slot, ppid: master!.child.pid!, startToken: `worker-${slot}`, executable: process.execPath,
      commandLine: `bun --bungee-process-identity=${instance}`, testMarker: master!.testMarker,
    }));
    const ingress: ProcessIdentitySnapshot = {
      pid: 54_013, ppid: master!.child.pid!, startToken: 'ingress', executable: process.execPath,
      commandLine: 'bun --bungee-process-identity=54000000-0000-4000-8000-000000000003',
      testMarker: master!.testMarker, roleMarker: 'ingress',
    };
    snapshot = [root(), ...workers, ingress];
    try {
      if (stable) {
        await waitUntil(() => master!.processes.registeredProcesses.filter(({ identity }) => identity !== undefined).length === 4,
          'stable monitor did not register the rooted descriptor tree', 5_000);
        const registered = master!.processes.registeredProcesses;
        expect(registered.filter(({ pid }) => pid === master!.child.pid)).toHaveLength(1);
        expect(registered.filter(({ role }) => role === 'worker')).toHaveLength(2);
        expect(registered.filter(({ role }) => role === 'ingress')).toHaveLength(1);
        expect(workerObservationDiagnostics(master!, new Set(workers.map(({ pid }) => pid)), snapshot)).toContain('descriptor_saved_count=2');
        expect(rootProofWriteEvidence(master!.processes).length).toBeGreaterThan(0);
      } else {
        await Bun.sleep(100);
        expect(master!.processes.registeredPids.filter((pid) => pid !== master!.child.pid)).toEqual([]);
        expect(masterLifecycleMapSizes(master!.processes, master!.child.pid!).masterRootProofs).toBe(0);
        expect(masterLifecycleMapSizes(master!.processes, master!.child.pid!).masterDescriptorProofs).toBe(0);
      }
    } finally {
      await master!.stopMonitoringAndDrain();
      master!.child.kill('SIGKILL');
      await master!.rootExit;
      await cleanupProcesses(master!.processes);
      await cleanupSpawnedProcesses(cleanupScope);
      await rm(fixture.root, { recursive: true, force: true });
    }
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
  const zero = masterLifecycleMapSizes(master.processes, master.child.pid);
  expect(zero.masterRootProofHistory).toBe(0);
  expect(zero.masterMonitorStates).toBe(0);
  expect(zero.descriptorDiagnostics).toBe(0);
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
      expect(master.rootExitState.confirmedBy).toBe('os_absence');
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
  expect(master.rootExitState.confirmedBy).toBe('os_absence');
  expect(signals).toEqual([`${root.pid}:SIGTERM`]);
});

test('missing direct root proof fails closed while a saved replacement releases only the old owner', async () => {
  const runCase = async (kind: 'missing' | 'mismatch', pid: number) => {
    const fixture = await createMasterFixture(`bungee-harness-direct-root-${kind}-`);
    const root: ProcessIdentitySnapshot = { pid, ppid: 1, startToken: kind, executable: '/bun', commandLine: `--bungee-test-root-marker=direct-${kind}`, testMarker: `direct-${kind}` };
    const signals: string[] = [];
    let replaced = false;
    let alive = true;
    const probes = {
      snapshot: async () => [replaced ? { ...root, startToken: 'replacement' } : root],
      identity: async () => kind === 'missing' ? null : replaced ? { ...root, startToken: 'replacement' } : root, alive: () => alive,
      signal: (childPid: number, signal: 'SIGTERM' | 'SIGKILL') => signals.push(`${childPid}:${signal}`), port: async () => 'closed' as const,
    };
    const master = createFakeRunningMaster({ fixture, root, testMarker: `direct-${kind}`, rootMarker: `direct-${kind}`, ports: [41_340], ingressPorts: [41_340], rootPorts: [41_340], workerCount: 0, probes });
    if (kind === 'missing') {
      await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow();
      expect(signals).toEqual([]);
      expect(await pathExists(fixture.root)).toBeTrue();
      alive = false;
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
      live.clear();
      master.settleRootExit('os_absence', null, null);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
    }
  };
  await runCase(1, 1_350);
  await runCase(2, 1_360);
});
