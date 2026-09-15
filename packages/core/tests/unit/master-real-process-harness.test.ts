import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { captureProcessIdentity, cleanupMaster, createMasterFixture, descendantProcessSnapshot, freePort, masterLifecycleMapSizes, parseWindowsChildPidsOutput, pathExists, probeTcpPort, registerDescendantPids, removeFixture, runWithCleanup, spawnMaster, waitForDead, waitForExit, waitForHealth, waitUntil, windowsChildPidsCommand, workerDescriptorsDirectory, workerIdentitiesFromSnapshot, MASTER_ROOT_KEY } from '../fixtures/master-real-process-harness';
import { cleanupProcesses, ProcessRegistry, processAlive } from '../fixtures/process-cleanup';
import type { ProcessIdentitySnapshot } from '../fixtures/process-cleanup';
import { deriveWorkerSupervisionCredential, deriveWorkerSupervisionSeed, signWorkerDescriptor } from '../../src/supervision';

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

test('captures root-exit evidence before the first delayed process snapshot', async () => {
  const fixture = await createMasterFixture('bungee-harness-first-snapshot-');
  const exitedMarker = join(fixture.root, 'root-exited');
  let snapshotAfterExit = false;
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e',
    `await Bun.write(${JSON.stringify(exitedMarker)}, 'exited'); process.exit(0);`],
  }, fixture, await freePort(), 0, fixture.root, fixture.accessDbPath, {}, {
    captureProcessSnapshot: async () => {
      await waitUntil(async () => {
        try { await stat(exitedMarker); return true; } catch { return false; }
      }, 'root did not reach its exit marker');
      snapshotAfterExit = true;
      return [];
    },
  });
  await master.rootExit;
  await waitUntil(() => snapshotAfterExit, 'first process snapshot was not observed after root exit');
  expect(snapshotAfterExit).toBeTrue();
  await cleanupMaster(master, [], { fixture });
});

test('drains a delayed monitor without allowing a late capture after stop', async () => {
  const fixture = await createMasterFixture('bungee-harness-monitor-drain-');
  let releaseSnapshot!: () => void;
  const snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve; });
  let snapshotCalls = 0;
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] },
    fixture, await freePort(), 0, fixture.root, fixture.accessDbPath, {}, {
      captureProcessSnapshot: async () => { snapshotCalls += 1; await snapshotGate; return []; },
    });
  await waitUntil(() => snapshotCalls > 0, 'monitor did not start a delayed snapshot');
  const draining = master.stopMonitoringAndDrain();
  releaseSnapshot();
  await draining;
  const callsAfterDrain = snapshotCalls;
  await Bun.sleep(100);
  expect(snapshotCalls).toBe(callsAfterDrain);
  await cleanupMaster(master, [], { fixture });
});

test('probes TCP state without treating HTTP responses as closed ports', async () => {
  const notFound = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('missing', { status: 404 }) });
  const hanging = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Promise<Response>(() => {}) });
  const closed = await freePort();
  try {
    expect(await probeTcpPort(notFound.port!)).toBe('open');
    expect(await probeTcpPort(hanging.port!)).toBe('open');
    expect(await probeTcpPort(closed)).toBe('closed');
  } finally {
    await notFound.stop(true);
    await hanging.stop(true);
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
  const worker: ProcessIdentitySnapshot = { pid: 201, ppid: 100, startToken: 'worker-start', executable: '/usr/bin/bun', commandLine: 'bun worker', testMarker: 'fixture-marker', roleMarker: 'worker' };
  const snapshot = [worker];
  const oldDirectChildResult = snapshot.filter(({ pid }) => new Set<number>().has(pid));
  expect(oldDirectChildResult).toEqual([]);
  expect(workerIdentitiesFromSnapshot(snapshot, 100, new Set([worker.pid]), 'fixture-marker')).toEqual([worker]);
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
  const workerInstance = '71000000-0000-4000-8000-000000000001';
  const ingressInstance = '71000000-0000-4000-8000-000000000002';
  const unrelatedInstance = '71000000-0000-4000-8000-000000000003';
  const generation = '71000000-0000-4000-8000-000000000004';
  const bootNonce = '71000000-0000-4000-8000-000000000005';
  const pidFile = join(fixture.root, 'rooted-pids.json');
  const marker = `--bungee-process-identity=${workerInstance}`;
  const rootScript = `const worker = Bun.spawn([${JSON.stringify(process.execPath)}, '-e', 'setInterval(() => {}, 60000)', ${JSON.stringify(marker)}], { stdio: ['ignore', 'ignore', 'ignore'] });
const ingress = Bun.spawn([${JSON.stringify(process.execPath)}, '-e', 'setInterval(() => {}, 60000)', ${JSON.stringify(`--bungee-process-identity=${ingressInstance}`)}], { stdio: ['ignore', 'ignore', 'ignore'] });
await Bun.write(${JSON.stringify(pidFile)}, JSON.stringify({ worker: worker.pid, ingress: ingress.pid }));
setInterval(() => {}, 60000);`;
  const signals: string[] = [];
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', rootScript] }, fixture, await freePort(), 1,
    fixture.root, fixture.accessDbPath, {}, { signal: (pid, signal) => { signals.push(`${pid}:${signal}`); process.kill(pid, signal); } });
  const unrelated = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60000)', `--bungee-process-identity=${unrelatedInstance}`], {
    stdout: 'ignore', stderr: 'ignore', env: { ...process.env, BUNGEE_TEST_PROCESS_MARKER: 'unrelated-worker' },
  });
  let realOwner: ProcessRegistry | null = null;
  const descriptor = (instance: string, pid: number, slot: number) => signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: generation,
    worker_instance_id: instance, worker_slot: slot, boot_nonce: bootNonce, pid, control_port: 40_010 + slot,
    phase: 'serving', frozen: false, private_port: 40_020 + slot, revision: 1,
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    started_at: 1, evidence: { kind: 'candidate' },
  }, deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, slot), bootNonce,
  ).process_key);
  let failure: unknown;
  const fallbackCleanup = async (): Promise<void> => {
    const descriptorPath = join(workerDescriptorsDirectory(fixture), `${unrelatedInstance}.json`);
    await rm(descriptorPath, { force: true });
    const cleanupResults = await Promise.allSettled([
      cleanupMaster(master, [], { fixture, expectGraceful: false }),
      (async () => { if (processAlive(unrelated.pid)) process.kill(unrelated.pid, 'SIGKILL'); await waitForDead([unrelated.pid]); })(),
      realOwner === null ? Promise.resolve() : cleanupProcesses(realOwner),
    ]);
    const errors = cleanupResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'rooted coverage fallback cleanup failed');
    await removeFixture(fixture);
  };
  try {
    await waitUntil(() => pathExists(pidFile), 'root did not publish rooted child PIDs');
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { worker: number; ingress: number };
    await mkdir(workerDescriptorsDirectory(fixture), { recursive: true });
    await writeFile(join(workerDescriptorsDirectory(fixture), `${workerInstance}.json`), `${JSON.stringify(descriptor(workerInstance, pids.worker, 0))}\n`);
    await writeFile(join(workerDescriptorsDirectory(fixture), `${unrelatedInstance}.json`), `${JSON.stringify(descriptor(unrelatedInstance, unrelated.pid, 1))}\n`);
    await waitUntil(() => {
      const registered = master.processes.registeredProcesses;
      return registered.some(({ pid, role }) => pid === pids.worker && role === 'worker')
        && registered.some(({ role, ports }) => role === 'ingress' && JSON.stringify(ports) === JSON.stringify(master.ingressPorts));
    }, 'rooted worker and exact ingress were not registered');
    expect(master.processes.ownsPid(unrelated.pid)).toBeFalse();
    await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
    expect(processAlive(master.child.pid!)).toBeTrue();
    expect(master.processes.ownsPid(unrelated.pid)).toBeFalse();
    expect(signals).toEqual([]);
    const unrelatedIdentity = await captureProcessIdentity(unrelated.pid);
    if (unrelatedIdentity === null) throw new Error('unrelated worker identity is unavailable');
    realOwner = new ProcessRegistry({ alive: () => false, requireTestMarker: false });
    expect(realOwner.registerPid(unrelated.pid, unrelatedIdentity, { role: 'worker' })).toBe(unrelated.pid);
    await cleanupProcesses(realOwner);
  } catch (error) { failure = error; }
  finally {
    try { await fallbackCleanup(); }
    catch (error) { failure = failure === undefined ? error : new AggregateError([failure, error], 'rooted coverage test cleanup failed'); }
  }
  if (failure !== undefined) throw failure;
});

test('root-dead current signed descriptor without saved identity fails closed', async () => {
  const fixture = await createMasterFixture('bungee-harness-root-dead-unsaved-');
  const instance = '72000000-0000-4000-8000-000000000001';
  const generation = '72000000-0000-4000-8000-000000000002';
  const bootNonce = '72000000-0000-4000-8000-000000000003';
  const worker = Bun.spawn([process.execPath, '-e', 'setInterval(() => {}, 60_000)', `--bungee-process-identity=${instance}`], {
    stdout: 'ignore', stderr: 'ignore', env: { ...process.env, BUNGEE_TEST_PROCESS_MARKER: 'unsaved-worker' },
  });
  const descriptor = signWorkerDescriptor({
    schema: 'bungee-worker-descriptor-v1', role: 'worker', master_generation: generation,
    worker_instance_id: instance, worker_slot: 0, boot_nonce: bootNonce, pid: worker.pid,
    control_port: 40_006, phase: 'serving', frozen: false, private_port: 40_007, revision: 1,
    content_hash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    plugin_catalog_hash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    started_at: 1, evidence: { kind: 'candidate' },
  }, deriveWorkerSupervisionCredential(
    deriveWorkerSupervisionSeed(MASTER_ROOT_KEY, generation, instance, 0), bootNonce,
  ).process_key);
  await mkdir(workerDescriptorsDirectory(fixture), { recursive: true });
  await writeFile(join(workerDescriptorsDirectory(fixture), `${instance}.json`), `${JSON.stringify(descriptor)}\n`);
  const signals: string[] = [];
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] },
    fixture, await freePort(), 0, fixture.root, fixture.accessDbPath, {}, {
      signal: (pid, signal) => { signals.push(`${pid}:${signal}`); process.kill(pid, signal); },
    });
  await runWithCleanup(async () => {
    if (master.child.pid === undefined) throw new Error('master PID is unavailable');
    await waitUntil(() => processAlive(master.child.pid!), 'master did not remain alive');
    await Bun.sleep(100);
    master.child.kill('SIGKILL');
    await master.rootExit;
    await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
    expect(master.processes.ownsPid(worker.pid)).toBeFalse();
    expect(signals).toEqual([]);
    expect(await pathExists(fixture.root)).toBeTrue();
  }, async () => {
    const settled = await Promise.allSettled([
      cleanupProcesses(master.processes),
      (async () => { if (processAlive(worker.pid)) process.kill(worker.pid, 'SIGKILL'); await waitForDead([worker.pid]); })(),
    ]);
    const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length > 0) throw new AggregateError(errors, 'root-dead unsaved cleanup failed');
    await removeFixture(fixture);
  });
});

test('cleanup accepts a dead signed descriptor without registering or signalling its PID', async () => {
  const fixture = await createMasterFixture('bungee-harness-dead-descriptor-');
  const port = await freePort();
  const ingressInstance = '70000000-0000-4000-8000-000000000002';
  const ingressScript = 'setInterval(() => {}, 60_000)';
  const script = `Bun.spawn([${JSON.stringify(process.execPath)}, '-e', ${JSON.stringify(ingressScript)}, '--bungee-process-identity=${ingressInstance}'], { stdio: ['ignore', 'ignore', 'ignore'] }); setInterval(() => {}, 60_000);`;
  const signals: string[] = [];
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', script] }, fixture, port, 0, fixture.root,
    fixture.accessDbPath, {}, { signal: (pid, signal) => { signals.push(`${pid}:${signal}`); process.kill(pid, signal); } });
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
  await writeFile(join(workerDescriptorsDirectory(fixture), `${instance}.json`), `${JSON.stringify(descriptor)}\n`, 'utf8');
  let cleaned = false;
  try {
    await waitUntil(() => {
      if (master.child.exitCode !== null || master.child.signalCode !== null) throw new Error(`real ingress root exited: ${master.output()}`);
      return master.processes.registeredProcesses.some(({ role }) => role === 'ingress');
    }, 'real ingress was not registered');
    expect(master.processes.ownsPid(deadPid)).toBeFalse();
    await cleanupMaster(master, [], { fixture, expectGraceful: false });
    cleaned = true;
    expect(signals.some((signal) => signal.startsWith(`${deadPid}:`))).toBeFalse();
  } finally {
    if (!cleaned) {
      master.stopMonitoring();
      if (master.child.pid !== undefined && processAlive(master.child.pid)) process.kill(master.child.pid, 'SIGKILL');
      await waitForExit(master.child).catch(() => undefined);
      await cleanupProcesses(master.processes).catch(() => undefined);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
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
    } finally {
      master.stopMonitoring();
      if (master.child.pid !== undefined && processAlive(master.child.pid)) master.child.kill('SIGKILL');
      await cleanupProcesses(master.processes);
    }
  }
});

test('accepts a live root with no registered ingress when all known ports are closed', async () => {
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', 'setInterval(() => {}, 60_000)'] }, {
    root: '/tmp/bungee-harness-coverage', dbPath: '/tmp/coverage.db', accessDbPath: '/tmp/coverage-access.db',
    configPath: '/tmp/coverage-config.json', pluginsPath: '/tmp/coverage-plugins',
  }, await freePort(), 1, '/tmp', '/tmp/coverage-access.db', {}, { stopProcessMonitor: true });
  await cleanupMaster(master);
  expect(master.processes.registeredPids).toEqual([]);
  expect(processAlive(master.child.pid!)).toBeFalse();
});

test('reclaims an early-exited root before the first identity snapshot when ports are closed', async () => {
  const fixture = await createMasterFixture('bungee-harness-early-exit-');
  const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', 'process.exit(0)'] }, fixture, await freePort(), 0);
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
    const master = spawnMaster({ name: 'source', executable: process.execPath, args: ['-e', script] },
      fixture, await freePort(), 0);
    if (master.child.pid === undefined) throw new Error('master PID is unavailable');
    const empty = Object.fromEntries(Object.keys(masterLifecycleMapSizes(master.processes, master.child.pid)).map((key) => [key, 0]));
    if (waitForExitFirst) await master.rootExit;
    await cleanupMaster(master, [], { fixture });
    expect(masterLifecycleMapSizes(master.processes, master.child.pid)).toEqual(empty);
  }
});
