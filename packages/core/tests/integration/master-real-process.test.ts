import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ConfigurationAggregateV2 } from '@jeffusion/bungee-types';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';
import {
  buildMasterEntries,
  captureProcessIdentity,
  captureProcessSnapshot,
  childPids,
  cleanupProcesses,
  cleanupMaster,
  cleanupSpawnedProcesses,
  createMasterCleanupScope,
  createMasterFixture,
  currentMasterChildren,
  expectPortClosed,
  freePort,
  isIngressProcess,
  isWorkerProcess,
  pathExists,
  processAlive,
  ProcessRegistry,
  removeFixture,
  runWithCleanup,
  spawnMaster,
  spawnAuthenticatedDaemonMaster,
  waitForDead,
  waitForExit,
  waitForHealth,
  waitForWorkerPids,
  waitForWorkerIdentities,
  MASTER_ROOT_KEY,
  readWorkerDescriptors,
  restoreDescriptorBackups,
  waitForWorkerDescriptors,
  waitUntil,
  type MasterEntry,
  type RunningMaster,
} from '../fixtures/master-real-process-harness';
import {
  deriveSupervisionProcessKey,
  deriveWorkerSupervisionCredential,
  deriveWorkerSupervisionSeed,
  hashSupervisionBody,
  parseSupervisionMessage,
  signSupervisionMessage,
  verifySupervisionMessage,
} from '../../src/supervision';
import { captureMacProcessMarkers, processIdentityMatches, type ProcessIdentitySnapshot } from '../fixtures/process-cleanup';
import { discoverIngressIdentity, IngressControllerClient } from '../../src/ingress/supervision-http';
import { admissionSetIdentity, type AdmissionSet } from '../../src/ingress';
import { hashConfigurationContent } from '../../src/config-storage/content-hash';
import { readSqliteVersion, selectAccessJournalMode } from '../../src/config-storage/sqlite-version';
import { acquireMasterInstanceLock } from '../../src/master-runtime/instance-lock';
import { createLaunchingDaemonMetadataFile, readDaemonMetadataFile } from '@jeffusion/bungee-types/daemon-file';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { DAEMON_AUTHORIZATION_HEADER, DAEMON_BOOT_HEADER, DAEMON_INSTANCE_HEADER, DAEMON_PID_HEADER, DAEMON_SHUTDOWN_PATH } from '../../src/daemon-control';

let buildRoot: string;
let entries: readonly MasterEntry[];

function revision(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    return db.query<{ readonly active_revision: number }, []>(
      'SELECT active_revision FROM configuration_state WHERE id=1',
    ).get()?.active_revision ?? -1;
  } finally {
    db.close(true);
  }
}

function accessDatabaseState(dbPath: string): { journalMode: unknown; hasAccessLogs: boolean } {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    return {
      journalMode: db.query<{ readonly journal_mode: unknown }, []>('PRAGMA journal_mode').get()?.journal_mode,
      hasAccessLogs: db.query<{ readonly name: string }, []>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_logs'",
      ).get() !== null,
    };
  } finally {
    db.close(true);
  }
}

type Authority = { readonly controller_epoch: number; readonly controller_id: string };
type WorkerDescriptor = Record<string, unknown>;

async function cleanupMasterAndFixture(
  master: RunningMaster,
  workers: readonly number[],
  fixture: Parameters<typeof removeFixture>[0],
): Promise<void> {
  const failures: unknown[] = [];
  try { await cleanupMaster(master, workers); } catch (error) { failures.push(error); }
  try { await removeFixture(fixture); } catch (error) { failures.push(error); }
  if (failures.length > 0) throw new AggregateError(failures, 'master and fixture cleanup failed');
}

function supervisionState(dbPath: string): { readonly instance_id: string } & Authority {
  const db = new Database(dbPath, { readonly: true, strict: true });
  try {
    const row = db.query<{ instance_id: string; controller_epoch: number; current_controller_id: string }, []>(
      'SELECT instance_id, controller_epoch, current_controller_id FROM supervision_state WHERE id=1',
    ).get();
    if (row === null || row.current_controller_id === null) throw new Error('supervision state is not claimed');
    return { instance_id: row.instance_id, controller_epoch: row.controller_epoch, controller_id: row.current_controller_id };
  } finally {
    db.close(true);
  }
}

async function waitForStartupHealth(port: number, master: RunningMaster): Promise<void> {
  if (process.platform !== 'win32') {
    await waitForHealth(port, master);
    return;
  }
  await waitUntil(async () => {
    if (master.child.exitCode !== null || master.child.signalCode !== null) {
      throw new Error(`master exited before health check: ${master.output()}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers: { connection: 'close' },
        signal: AbortSignal.timeout(250),
      });
      return response.status === 200 && await response.text() === '{"status":"ok"}';
    } catch (error) {
      if (error instanceof Error) return false;
      throw error;
    }
  }, `master did not serve health: ${master.output()}`, 40_000);
}

async function ingressPid(masterPid: number): Promise<number> {
  let found: number | undefined;
  await waitUntil(async () => {
    for (const pid of await childPids(masterPid)) if (await isIngressProcess(pid)) found = pid;
    return found !== undefined;
  }, `master ${masterPid} did not expose an ingress PID`);
  return found!;
}

function descriptorSnapshot(descriptor: WorkerDescriptor): unknown {
  return {
    schema: descriptor.schema, role: descriptor.role, master_generation: descriptor.master_generation,
    worker_instance_id: descriptor.worker_instance_id, worker_slot: descriptor.worker_slot,
    boot_nonce: descriptor.boot_nonce, pid: descriptor.pid, control_port: descriptor.control_port,
    phase: descriptor.phase, frozen: descriptor.frozen, private_port: descriptor.private_port,
    revision: descriptor.revision, content_hash: descriptor.content_hash,
    plugin_catalog_hash: descriptor.plugin_catalog_hash, started_at: descriptor.started_at,
    evidence: descriptor.evidence,
  };
}

function sortedWorkerIdentityTuples(
  workers: readonly (WorkerDescriptor | AdmissionSet['workers'][number])[],
): string[] {
  return workers.map((worker) => JSON.stringify([
    worker.master_generation, worker.worker_instance_id, worker.worker_slot, worker.boot_nonce, worker.private_port,
  ])).sort();
}

function assertCompleteReadyDescriptor(descriptor: WorkerDescriptor): void {
  expect(Object.keys(descriptor).sort()).toEqual([
    'boot_nonce', 'content_hash', 'control_port', 'descriptor_mac', 'evidence', 'frozen',
    'master_generation', 'phase', 'pid', 'plugin_catalog_hash', 'private_port', 'revision',
    'role', 'schema', 'started_at', 'worker_instance_id', 'worker_slot',
  ]);
  expect(descriptor.phase).toBe('serving');
  expect((descriptor.evidence as { kind?: string }).kind).toBe('ready');
}

async function businessRequests(port: number, body: string, upstream: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(`http://127.0.0.1:${port}/proxy`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-fixture-upstream')).toBe(upstream);
    expect(await response.text()).toBe(body);
  }
}

async function signedCommand(
  baseUrl: string,
  credential: ReturnType<typeof deriveSupervisionProcessKey>,
  authority: Authority,
  sequence: number,
  path: string,
  body: unknown,
): Promise<{ readonly response: Response; readonly payload: Record<string, unknown> }> {
  const requestId = randomUUID();
  const message = signSupervisionMessage({
    protocol: 'bungee-supervision-v1', kind: 'command', direction: 'controller-to-process',
    ...credential.identity, ...authority, sequence, request_id: requestId,
    method: 'POST', path, body_hash: hashSupervisionBody(body),
  }, credential);
  const response = await fetch(`${baseUrl}/__supervision/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, body }),
  });
  return { response, payload: await response.json() as Record<string, unknown> };
}

async function signedWorkerStatus(
  baseUrl: string,
  credential: ReturnType<typeof deriveSupervisionProcessKey>,
  authority: Authority,
  sequence: number,
): Promise<{ readonly body: Record<string, unknown>; readonly responseSequence: number }> {
  const requestId = randomUUID();
  const message = signSupervisionMessage({
    protocol: 'bungee-supervision-v1', kind: 'status', direction: 'process-to-controller',
    ...credential.identity, ...authority, sequence, request_id: requestId,
    status: 'request', body_hash: hashSupervisionBody(null),
  }, credential);
  const response = await fetch(`${baseUrl}/__supervision/status`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(message),
  });
  expect(response.status).toBe(200);
  const payload = await response.json() as { body: Record<string, unknown>; message: unknown };
  const responseMessage = parseSupervisionMessage(payload.message);
  verifySupervisionMessage(responseMessage, credential);
  if (responseMessage.kind !== 'status') throw new Error('worker supervision response is not status');
  expect(responseMessage).toMatchObject({
    kind: 'status', direction: 'process-to-controller', role: 'worker',
    process_instance_id: credential.identity.process_instance_id,
    boot_nonce: credential.identity.boot_nonce,
    controller_epoch: authority.controller_epoch,
    controller_id: authority.controller_id,
    request_id: requestId,
  });
  expect(responseMessage.body_hash).toBe(hashSupervisionBody(payload.body));
  expect(payload.body.request_correlation).toBe(requestId);
  expect(payload.body.authority).toEqual(authority);
  expect(payload.body.replay).toEqual({ sequence: responseMessage.sequence, request_id: requestId });
  return { body: payload.body, responseSequence: responseMessage.sequence };
}

function workerRuntimeSnapshot(status: Record<string, unknown>): unknown {
  return {
    phase: status.phase, frozen: status.frozen, revision: status.revision,
    content_hash: status.content_hash, plugin_catalog_hash: status.plugin_catalog_hash,
    private_port: status.private_port, evidence: status.evidence,
  };
}

async function supervisionCall<T>(label: string, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) { throw new Error(`${label}: ${String(error)}`, { cause: error }); }
}

async function revalidateSavedIdentities(
  saved: readonly { readonly pid: number; readonly identity: ProcessIdentitySnapshot }[],
): Promise<void> {
  const errors: unknown[] = [];
  for (const entry of saved) {
    try {
      const actual = await captureProcessIdentity(entry.pid);
      if (actual !== null && !processIdentityMatches(entry.identity, actual)) {
        errors.push(new Error(`saved process identity changed for PID ${entry.pid}`));
      }
    } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'saved process identity revalidation failed');
}

beforeAll(async () => {
  buildRoot = makeCanonicalTempDir('bungee-master-build');
  entries = await buildMasterEntries(buildRoot);
}, 120_000);

afterAll(async () => {
  if (buildRoot !== undefined) await rm(buildRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});
const cleanupScope = createMasterCleanupScope();
afterEach(() => cleanupSpawnedProcesses(cleanupScope));

describe.serial('real SQLite master process', () => {
  test('source, fresh dist, and compiled entries start at revision one and shut down cleanly', async () => {
    for (const entry of entries) {
      const fixture = await createMasterFixture(`bungee-master-${entry.name}-`);
      const port = await freePort(cleanupScope);
      let daemon: Awaited<ReturnType<typeof spawnAuthenticatedDaemonMaster>> | undefined;
      let windowsProcessCleaned = false;
      const master = process.platform === 'win32'
        ? (daemon = await spawnAuthenticatedDaemonMaster(cleanupScope, entry, fixture, port)).master
        : spawnMaster(cleanupScope, entry, fixture, port);
      let workers: readonly number[] = [];
      await runWithCleanup(async () => {
        await waitForStartupHealth(port, master);
        if (master.child.pid === undefined) throw new Error('master PID is unavailable');
        if (daemon !== undefined) await daemon.waitForArmed();
        workers = await waitForWorkerPids(master, 2);
        expect(new Set(workers).size).toBe(2);
        expect(workers.every(processAlive)).toBeTrue();
        expect(await pathExists(fixture.accessDbPath)).toBeTrue();
        expect(await pathExists(`${fixture.accessDbPath}.lock`)).toBeTrue();
        expect(await pathExists(join(fixture.root, 'logs', 'access.db'))).toBeFalse();
        const runtime = new Database(':memory:');
        const expectedJournalMode = selectAccessJournalMode(readSqliteVersion(runtime));
        runtime.close(true);
        expect(accessDatabaseState(fixture.accessDbPath)).toEqual({ journalMode: expectedJournalMode, hasAccessLogs: true });
        expect(revision(fixture.dbPath)).toBe(1);

        await writeFile(fixture.configPath, '{still invalid', 'utf8');
        await waitForHealth(port, master);
        expect(await waitForWorkerPids(master, 2)).toEqual(workers);
        expect(revision(fixture.dbPath)).toBe(1);
        await waitForHealth(port, master);

        if (process.platform === 'win32') {
          await master.synchronizeOwnership();
          const registered = master.processes.registeredProcesses;
          expect(registered.filter(({ role }) => role === 'worker')).toHaveLength(2);
          const ingress = registered.filter(({ role }) => role === 'ingress');
          expect(ingress).toHaveLength(1);
          expect(ingress[0]!.ports).toEqual(master.ingressPorts);
          const exactChildren = (await currentMasterChildren(master)).map(({ pid }) => pid);
          expect(exactChildren).toHaveLength(3);
          await cleanupMaster(master, [], { fixture, expectGraceful: true });
          windowsProcessCleaned = true;
          if (daemon === undefined) throw new Error('authenticated daemon harness is unavailable');
          expect(daemon.shutdownRequested()).toBeTrue();
          expect(await waitForExit(master.child)).toEqual({ code: 0, signal: null });
          expect(master.processes.registeredPids).toEqual([]);
          expect(await pathExists(daemon.metadataPath)).toBeFalse();
          await waitForDead(exactChildren);
          expect(daemon.fallbackSignals).toEqual([]);
          await Promise.all(master.ports.map(expectPortClosed));
          const locks = [] as Array<{ readonly release: () => Promise<void> }>;
          try {
            locks.push(await acquireMasterInstanceLock(`${fixture.dbPath}.lock`));
            locks.push(await acquireMasterInstanceLock(`${fixture.accessDbPath}.lock`));
          } finally {
            for (const lock of locks.reverse()) await lock.release();
          }
        } else {
          await master.synchronizeOwnership();
          master.child.kill('SIGTERM');
          const exit = await waitForExit(master.child);
          expect(exit).toEqual({ code: 0, signal: null });
          await waitForDead(workers);
          await expectPortClosed(port);
          expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
          expect(await pathExists(`${fixture.accessDbPath}.lock`)).toBeTrue();
        }
      }, async () => {
        const cleanupTasks: Promise<void>[] = [];
        if (!windowsProcessCleaned || process.platform !== 'win32') cleanupTasks.push(cleanupMasterAndFixture(master, [], fixture));
        if (daemon !== undefined) cleanupTasks.push(daemon.cleanupRuntime());
        const settled = await Promise.allSettled(cleanupTasks);
        const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
        if (failures.length > 0) throw new AggregateError(failures, 'source master cleanup failed');
      });
    }
  }, 90_000);

  test('Darwin cleanup causality covers the root, workers, and ingress across fresh masters', async () => {
    if (process.platform !== 'darwin') return;
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    for (let round = 0; round < 2; round += 1) {
      const fixture = await createMasterFixture(`bungee-master-darwin-cleanup-${round}-`);
      const port = await freePort(cleanupScope);
      const master = spawnMaster(cleanupScope, entry, fixture, port);
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitForWorkerPids(master, 2);
      await waitUntil(() => master.processes.registeredProcesses.filter(({ identity }) => identity !== undefined).length === 4,
        'Darwin cleanup registry did not capture root, workers, and ingress');
      const registered = master.processes.registeredProcesses;
      expect(registered.filter(({ pid }) => pid === master.child.pid)).toHaveLength(1);
      expect(registered.filter(({ role }) => role === 'worker')).toHaveLength(2);
      const ingress = registered.filter(({ role }) => role === 'ingress');
      expect(ingress).toHaveLength(1);
      expect(ingress[0]!.ports).toEqual(master.ingressPorts);
      const saved = registered.flatMap((entry) => entry.identity === undefined ? [] : [{ ...entry }]);
      const savedPids = saved.map(({ pid }) => pid);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
      expect(savedPids.every((pid) => !processAlive(pid))).toBeTrue();
      expect(master.processes.registeredPids).toEqual([]);
      await Promise.all(master.ports.map((candidate) => expectPortClosed(candidate)));
      const reclaimed = new ProcessRegistry({ alive: () => false });
      for (const entry of saved) {
        if (entry.identity === undefined) continue;
        if (entry.role === 'ingress') {
          expect(reclaimed.registerAdoptedIngress(entry.pid, entry.ports ?? [], entry.identity)).toBe(entry.pid);
        } else {
          expect(reclaimed.registerPid(entry.pid, entry.identity, { role: entry.role })).toBe(entry.pid);
        }
      }
      expect(reclaimed.portOwnedByThis(master.ingressPorts[0]!)).toBeTrue();
      await cleanupProcesses(reclaimed);
      const released = new ProcessRegistry({ alive: () => false });
      for (const entry of saved) {
        if (entry.identity === undefined) continue;
        expect(entry.role === 'ingress'
          ? released.registerAdoptedIngress(entry.pid, entry.ports ?? [], entry.identity)
          : released.registerPid(entry.pid, entry.identity, { role: entry.role })).toBe(entry.pid);
      }
      const releasedIngress = saved.find(({ role }) => role === 'ingress');
      expect(released.portOwnedByThis(master.ingressPorts[0]!)).toBeTrue();
      expect(releasedIngress?.identity === undefined ? false : released.release(releasedIngress.identity)).toBeTrue();
      expect(released.portOwnedByThis(master.ingressPorts[0]!)).toBeFalse();
      await cleanupProcesses(released);
      expect(await pathExists(fixture.root)).toBeFalse();
    }
  }, 45_000);

  test('cleanup coverage fails when a live signed worker descriptor is missing, without signalling', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-coverage-worker-gap-');
    const port = await freePort(cleanupScope);
    const signals: string[] = [];
    const master = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath, {}, {
      signal: (pid, signal) => { signals.push(`${pid}:${signal}`); process.kill(pid, signal); },
    });
    let backup: string | undefined;
    let cleaned = false;
    let savedIdentities: Array<{ readonly pid: number; readonly identity: ProcessIdentitySnapshot }> = [];
    await runWithCleanup(async () => {
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      await waitForWorkerPids(master, 2);
      await waitUntil(() => master.processes.registeredProcesses.filter(({ identity }) => identity !== undefined).length === 4,
        'coverage fixture did not capture root, workers, and ingress');
      const registered = master.processes.registeredProcesses;
      expect(registered.filter(({ role }) => role === 'ingress')[0]?.ports).toEqual(master.ingressPorts);
      savedIdentities = registered.flatMap(({ pid, identity }) => identity === undefined ? [] : [{ pid, identity }]);
      const savedRootHandle = master.child;
      if (savedRootHandle.pid !== master.child.pid) throw new Error('root handle changed before descriptor break');
      const descriptor = (await readWorkerDescriptors(fixture))[0];
      if (typeof descriptor?.worker_instance_id !== 'string') throw new Error('worker descriptor identity is unavailable');
      const descriptorPath = join(fixture.root, 'data', 'runtime', 'workers', `${descriptor.worker_instance_id}.json`);
      backup = `${descriptorPath}.backup`;
      await rename(descriptorPath, backup);
      await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
      expect(signals).toEqual([]);
      expect(savedIdentities.every(({ pid }) => processAlive(pid))).toBeTrue();
      await restoreDescriptorBackups([{ path: descriptorPath, backup }]);
      backup = undefined;
      await revalidateSavedIdentities(savedIdentities);
      await cleanupMaster(master, [], { fixture, expectGraceful: false });
      cleaned = true;
    }, async () => {
      const cleanupErrors: unknown[] = [];
      if (backup !== undefined) {
        try {
          await restoreDescriptorBackups([{ path: backup.slice(0, -'.backup'.length), backup }]);
          backup = undefined;
        }
        catch (error) { cleanupErrors.push(error); }
      }
      if (!cleaned) {
        try { await revalidateSavedIdentities(savedIdentities); }
        catch (error) { cleanupErrors.push(error); }
        try { await cleanupMaster(master, [], { expectGraceful: false }); }
        catch (firstError) {
          cleanupErrors.push(firstError);
          try { await cleanupMaster(master, [], { expectGraceful: false }); }
          catch (secondError) { cleanupErrors.push(secondError); }
        }
        if (cleanupErrors.length === 0) {
          try { await removeFixture(fixture); cleaned = true; }
          catch (error) { cleanupErrors.push(error); }
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'worker descriptor cleanup fallback failed');
    });
  }, 45_000);

  test('cleanup coverage fails independently when ingress is missing, without signalling workers', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-coverage-ingress-gap-');
    const port = await freePort(cleanupScope);
    const signals: string[] = [];
    const master = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath, {}, {
      signal: (pid, signal) => { signals.push(`${pid}:${signal}`); process.kill(pid, signal); },
    });
    let cleaned = false;
    let savedIdentities: Array<{ readonly pid: number; readonly identity: ProcessIdentitySnapshot }> = [];
    await runWithCleanup(async () => {
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      const workers = await waitForWorkerPids(master, 2);
      await waitUntil(() => master.processes.registeredProcesses.filter(({ identity }) => identity !== undefined).length === 4,
        'coverage fixture did not capture root, workers, and ingress');
      const ingress = master.processes.registeredProcesses.find(({ role }) => role === 'ingress');
      if (ingress === undefined) throw new Error('ingress registration is unavailable');
      savedIdentities = master.processes.registeredProcesses.flatMap(({ pid, identity }) => identity === undefined ? [] : [{ pid, identity }]);
      process.kill(ingress.pid, 'SIGKILL');
      await waitForDead([ingress.pid]);
      await expect(cleanupMaster(master, [], { fixture, expectGraceful: false })).rejects.toThrow('coverage');
      expect(signals).toEqual([]);
      expect(processAlive(master.child.pid)).toBeTrue();
      expect(workers.every(processAlive)).toBeTrue();
      await revalidateSavedIdentities(savedIdentities);
      const cleanupView = { ...master, ports: master.ports, ingressPorts: [] };
      await cleanupMaster(cleanupView, [], { ports: master.ports, expectGraceful: false });
      await Promise.all(master.ports.map(expectPortClosed));
      await removeFixture(fixture);
      cleaned = true;
    }, async () => {
      const cleanupErrors: unknown[] = [];
      if (!cleaned) {
        try { await revalidateSavedIdentities(savedIdentities); }
        catch (error) { cleanupErrors.push(error); }
        const cleanupView = { ...master, ports: master.ports, ingressPorts: [] };
        try { await cleanupMaster(cleanupView, [], { ports: master.ports, expectGraceful: false }); }
        catch (firstError) {
          cleanupErrors.push(firstError);
          try { await cleanupMaster(cleanupView, [], { ports: master.ports, expectGraceful: false }); }
          catch (secondError) { cleanupErrors.push(secondError); }
        }
        if (cleanupErrors.length === 0) {
          try {
            await Promise.all(master.ports.map(expectPortClosed));
            await removeFixture(fixture);
            cleaned = true;
          } catch (error) { cleanupErrors.push(error); }
        }
      }
      if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, 'ingress cleanup fallback failed');
    });
  }, 45_000);

  test('real daemon bootstrap arms and shuts down through the authenticated management listener', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-daemon-real-');
    const runtimeHome = makeCanonicalTempDir('bungee-daemon-home');
    const runtimeDirectory = join(runtimeHome, '.bungee', 'run');
    await mkdir(runtimeDirectory, { recursive: true });
    const metadataPath = join(runtimeDirectory, 'daemon.json');
    const port = await freePort(cleanupScope);
    const bootNonce = randomUUID();
    const shutdownSecret = randomBytes(32).toString('base64url');
    const metadata: DaemonMetadataV1 = {
      schema: 'bungee-daemon-metadata-v1', state: 'launching', launcher_pid: process.pid,
      boot_nonce: bootNonce, shutdown_secret: shutdownSecret, executable: entry.executable,
      entrypoint: entry.name === 'compiled' ? null : entry.args[0]!, pid: null, instance_id: null,
      management_host: null, management_port: null,
    };
    await createLaunchingDaemonMetadataFile(metadataPath, metadata, { runtimeDirectory });
    const master = spawnMaster(cleanupScope, entry, fixture, port, 2, fixture.root, fixture.accessDbPath, {
      HOME: runtimeHome, USERPROFILE: runtimeHome,
      BUNGEE_DAEMON_METADATA_PATH: metadataPath, BUNGEE_DAEMON_BOOT_NONCE: bootNonce,
      BUNGEE_DAEMON_SHUTDOWN_SECRET: shutdownSecret,
    }, { daemonBootNonce: bootNonce });
    let gracefulRequested = false;
    let primaryError: unknown;
    try {
      let armed: Extract<DaemonMetadataV1, { readonly state: 'armed' }> | undefined;
      await waitUntil(async () => (await readDaemonMetadataFile(metadataPath, { runtimeDirectory })).state === 'starting',
        'real daemon did not transition to starting', 30_000);
      await waitUntil(async () => {
        const current = await readDaemonMetadataFile(metadataPath, { runtimeDirectory });
        if (current.state !== 'armed') return false;
        armed = current;
        return true;
      }, 'real daemon did not transition from starting to armed', 30_000);
      if (armed === undefined || armed.management_port === null || armed.instance_id === null || armed.pid === null) {
        throw new Error('armed daemon metadata is incomplete');
      }
      const masterPid = master.child.pid;
      if (masterPid === undefined) throw new Error('real daemon master PID is unavailable');
      const workerIdentities = await waitForWorkerIdentities(master, 2);
      const realIngressPid = await ingressPid(masterPid);
      const ingressProof = await captureProcessIdentity(realIngressPid);
      if (ingressProof === null) throw new Error('real daemon ingress identity is unavailable');
      const savedIdentities = [...workerIdentities, ingressProof];
      await waitUntil(() => savedIdentities.every(({ pid }) => master.processes.ownsPid(pid)),
        'real daemon registry did not capture exact worker and ingress ownership', 5_000);
      const registered = master.processes.registeredProcesses;
      expect(registered.find(({ pid }) => pid === masterPid)?.hasLiveHandle).toBeTrue();
      const registeredIdentities = registered.filter(({ identity }) => identity !== undefined);
      expect(registeredIdentities).toHaveLength(4);
      expect(registeredIdentities.map(({ pid }) => pid))
        .toEqual(expect.arrayContaining(savedIdentities.map(({ pid }) => pid)));
      const response = await fetch(`http://127.0.0.1:${armed.management_port}${DAEMON_SHUTDOWN_PATH}`, {
        method: 'POST',
        headers: {
          [DAEMON_AUTHORIZATION_HEADER]: `Bearer ${shutdownSecret}`,
          [DAEMON_BOOT_HEADER]: bootNonce,
          [DAEMON_INSTANCE_HEADER]: armed.instance_id,
          [DAEMON_PID_HEADER]: String(armed.pid),
          'content-length': '0',
        },
      });
      expect(response.status).toBe(202);
      expect(await response.text()).toBe(JSON.stringify({ status: 'accepted', boot_nonce: armed.boot_nonce, instance_id: armed.instance_id, pid: armed.pid }));
      gracefulRequested = true;
      expect(await waitForExit(master.child)).toEqual({ code: 0, signal: null });
      await waitUntil(() => pathExists(metadataPath).then((exists) => !exists), 'real daemon metadata was not deleted', 5_000);
      await Promise.all([
        waitForDead(savedIdentities.map(({ pid }) => pid)),
        ...[port, port + 1, port + 2].map((candidate) => expectPortClosed(candidate)),
      ]);
    } catch (error) {
      primaryError = error;
    }
    const processCleanup = await Promise.allSettled([
      cleanupMaster(master, [], { fixture, expectGraceful: gracefulRequested }),
    ]);
    const resourceCleanup = await Promise.allSettled([
      rm(runtimeHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ]);
    const cleanupFailures = [...processCleanup, ...resourceCleanup]
      .flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (primaryError !== undefined || cleanupFailures.length > 0) {
      throw new AggregateError([...(primaryError === undefined ? [] : [primaryError]), ...cleanupFailures], 'real daemon test failed');
    }
    expect(master.processes.registeredPids.filter(processAlive)).toEqual([]);
    expect(await expectPortClosed(port)).toBeUndefined();
  }, 45_000);

  test('authenticated ingress session gives two real workers one shared rate-limit bucket', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-rate-session-');
    const port = await freePort(cleanupScope);
    const upstream = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('rate-upstream') });
    if (upstream.port === undefined) throw new Error('upstream port is unavailable');
    const master = spawnMaster(cleanupScope, entry, fixture, port);
    let workers: readonly number[] = [];
    const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    await runWithCleanup(async () => {
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      workers = await waitForWorkerPids(master, 2);
      const aggregate: ConfigurationAggregateV2 = {
        plugin_activations: [],
        logical_configuration: {
          auth: { enabled: true, tokens: [token] }, plugins: [],
          services: [{
            id: 'a1000000-0000-4000-8000-000000000001', position: 1, name: 'rate-service', plugins: [], endpoints: [{
              id: 'a2000000-0000-4000-8000-000000000001', position: 1, target: `http://127.0.0.1:${upstream.port}`,
              weight: 100, priority: 1, is_disabled: false, plugins: [],
            }],
          }],
          routes: [{
            id: 'a3000000-0000-4000-8000-000000000001', position: 1, path: '/limited',
            service_id: 'a1000000-0000-4000-8000-000000000001', auth: { enabled: false, tokens: [] }, plugins: [],
            rate_limit: { enabled: true, requests_per_second: 1, burst: 1 },
          }],
        },
      };
      const mutationId = 'a4000000-0000-4000-8000-000000000001';
      const mutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: 1, aggregate, mutation_id: mutationId }),
      });
      expect(mutation.status).toBe(202);
      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationId}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        return (await response.json() as { operation?: { state?: string } }).operation?.state === 'converged';
      }, 'rate-limit publication did not converge', 20_000);
      const first = await fetch(`http://127.0.0.1:${port + 1}/limited`);
      const second = await fetch(`http://127.0.0.1:${port + 1}/limited`);
      expect(first.status).toBe(200);
      expect(await first.text()).toBe('rate-upstream');
      expect(second.status).toBe(429);
    }, async () => {
      const settled = await Promise.allSettled([cleanupMaster(master, workers), upstream.stop(true)]);
      const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'master rate-limit cleanup failed');
      await removeFixture(fixture);
    });
  }, 45_000);

  test('repairs a killed admitted worker without interrupting the master listener', async () => {
    const fixture = await createMasterFixture('bungee-master-repair-');
    const port = await freePort(cleanupScope);
    const master = spawnMaster(cleanupScope, entries[0], fixture, port);
    let ownedPids: readonly number[] = [];
    await runWithCleanup(async () => {
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      const masterPid = master.child.pid;
      const initialPids = await waitForWorkerPids(master, 2);
      ownedPids = initialPids;
      const killedPid = initialPids[0];
      process.kill(killedPid, 'SIGKILL');
      await waitForDead([killedPid]);

      let repairedPids: readonly number[] = [];
      await waitUntil(async () => {
        expect(master.child.exitCode).toBeNull();
        expect(master.child.signalCode).toBeNull();
        let health: Response;
        try {
          health = await fetch(`http://127.0.0.1:${port}/health`, {
            headers: { connection: 'close' },
            signal: AbortSignal.timeout(250),
          });
        } catch (error) {
          throw new Error(`health connection failed: ${String(error)} output=${master.output()}`);
        }
        expect(health.status).toBe(200);
        repairedPids = await waitForWorkerPids(master, 2);
        return repairedPids.length === 2
          && !repairedPids.includes(killedPid)
          && repairedPids.every(processAlive);
      }, `master did not repair worker ${killedPid}: ${master.output()}`, 10_000);

      ownedPids = [...new Set([...initialPids, ...repairedPids])];
      expect(repairedPids).toHaveLength(2);
      expect(repairedPids).not.toContain(killedPid);
      await waitForHealth(port, master);
    }, async () => {
      const settled = await Promise.allSettled([cleanupMaster(master, ownedPids)]);
      const errors = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'master repair cleanup failed');
      await removeFixture(fixture);
    });
  }, 30_000);

  test('rejects a concurrent master for the same database without disturbing the owner', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-lock-');
    const firstPort = await freePort(cleanupScope);
    const secondPort = await freePort(cleanupScope);
    const first = spawnMaster(cleanupScope, entry, fixture, firstPort);
    let second: RunningMaster | null = null;
    let workers: readonly number[] = [];
    await runWithCleanup(async () => {
      await waitForHealth(firstPort, first);
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      workers = await waitForWorkerPids(first, 2);
      second = spawnMaster(cleanupScope, entry, fixture, secondPort);
      const secondExit = await waitForExit(second.child);
      expect(secondExit.code).not.toBe(0);
      expect(second.output()).toContain('"code":"held"');
      expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
      await waitForHealth(firstPort, first);
      await expectPortClosed(secondPort);
    }, async () => {
      const masters = await Promise.allSettled([
        ...(second === null ? [] : [cleanupMaster({ ...second, ports: [], ingressPorts: [], workerCount: 0 })]),
        cleanupMaster(first, workers),
      ]);
      const errors = masters.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'master lock cleanup failed');
      await removeFixture(fixture);
    });
  }, 30_000);

  test('rejects different config databases that share one access database', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const firstFixture = await createMasterFixture('bungee-master-access-owner-');
    const secondFixture = await createMasterFixture('bungee-master-access-contender-');
    const firstPort = await freePort(cleanupScope);
    const secondPort = await freePort(cleanupScope);
    const accessLockPath = `${firstFixture.accessDbPath}.lock`;
    let firstDaemon: Awaited<ReturnType<typeof spawnAuthenticatedDaemonMaster>> | null = null;
    const first = process.platform === 'win32'
      ? (firstDaemon = await spawnAuthenticatedDaemonMaster(cleanupScope, entry, firstFixture, firstPort)).master
      : spawnMaster(cleanupScope, entry, firstFixture, firstPort);
    let second: RunningMaster | null = null;
    let workers: readonly number[] = [];
    await runWithCleanup(async () => {
      await waitForHealth(firstPort, first);
      if (firstDaemon !== null) await firstDaemon.waitForArmed();
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      workers = await waitForWorkerPids(first, 2);
      second = spawnMaster(cleanupScope, entry, secondFixture, secondPort, 2, firstFixture.root, firstFixture.accessDbPath);

      expect((await waitForExit(second.child)).code).toBe(1);
      expect(second.output()).toContain('access.db.lock');
      expect(await pathExists(`${secondFixture.dbPath}.lock`)).toBeTrue();
      expect(await pathExists(accessLockPath)).toBeTrue();
      await waitForHealth(firstPort, first);

      await first.synchronizeOwnership();
      if (firstDaemon !== null) {
        if (first.shutdown === undefined) throw new Error('authenticated daemon shutdown handler is unavailable');
        await first.shutdown();
        expect(firstDaemon.shutdownRequested()).toBeTrue();
      } else {
        first.child.kill('SIGTERM');
      }
      expect(await waitForExit(first.child)).toEqual({ code: 0, signal: null });
      await waitForDead(workers);
      expect(await pathExists(accessLockPath)).toBeTrue();
      if (firstDaemon !== null) {
        expect(firstDaemon.fallbackSignals).toEqual([]);
        expect(await pathExists(firstDaemon.metadataPath)).toBeFalse();
      }
    }, async () => {
      const cleanupTasks: Promise<void>[] = [cleanupMasterAndFixture(first, workers, firstFixture)];
      if (second === null) cleanupTasks.push(removeFixture(secondFixture));
      else cleanupTasks.push(cleanupMasterAndFixture({ ...second, ports: [], ingressPorts: [], workerCount: 0 }, [], secondFixture));
      if (firstDaemon !== null) cleanupTasks.push(firstDaemon.cleanupRuntime());
      const settled = await Promise.allSettled(cleanupTasks);
      const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'master access-owner cleanup failed');
    });
  }, 30_000);

  test('occupied management port fails startup with zero side effects', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-port-');
    const occupiedPort = await freePort(cleanupScope);
    const occupied = Bun.serve({ hostname: '127.0.0.1', port: occupiedPort, fetch: () => new Response('occupied') });
    const master = spawnMaster(cleanupScope, entry, fixture, occupiedPort);
    await runWithCleanup(async () => {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      const observedChildren = new Set<number>();
      await waitUntil(async () => {
        for (const pid of await childPids(master.child.pid!)) observedChildren.add(pid);
        return master.child.exitCode !== null || master.child.signalCode !== null;
      }, 'master did not fail its occupied-port startup', 30_000);
      const result = await waitForExit(master.child);
      expect(result.code).not.toBe(0);
      expect(observedChildren.size).toBe(0);
      expect(await readWorkerDescriptors(fixture)).toHaveLength(0);
      const snapshot = process.platform === 'win32' ? [] : await captureProcessSnapshot();
      expect(snapshot.filter(({ testMarker, roleMarker }) => testMarker === master.testMarker
        && (roleMarker === 'worker' || roleMarker === 'ingress'))).toHaveLength(0);
      if (process.platform === 'darwin') {
        const markerProcesses = await Promise.all(snapshot
          .filter(({ commandLine }) => commandLine.includes('--bungee-process-identity='))
          .map(async ({ pid }) => captureMacProcessMarkers(pid)));
        expect(markerProcesses.filter(({ testMarker, roleMarker }) => testMarker === master.testMarker
          && (roleMarker === 'worker' || roleMarker === 'ingress'))).toHaveLength(0);
      }
      const occupiedResponse = await fetch(`http://127.0.0.1:${occupiedPort}`);
      expect(occupiedResponse.status).toBe(200);
      expect(await occupiedResponse.text()).toBe('occupied');
      await Promise.all([expectPortClosed(occupiedPort + 1), expectPortClosed(occupiedPort + 2)]);
      const locks = [] as Array<{ readonly release: () => Promise<void> }>;
      try {
        locks.push(await acquireMasterInstanceLock(`${fixture.dbPath}.lock`));
        locks.push(await acquireMasterInstanceLock(`${fixture.accessDbPath}.lock`));
      } finally {
        for (const lock of locks.reverse()) await lock.release();
      }
    }, async () => {
      const stopped = await Promise.allSettled([occupied.stop(true)]);
      const settled = await Promise.allSettled([
        cleanupMaster(master, []),
        expectPortClosed(occupiedPort),
      ]);
      const errors = [
        ...stopped.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
        ...settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []),
      ];
      if (errors.length > 0) throw new AggregateError(errors, 'occupied-port cleanup failed');
      await removeFixture(fixture);
      expect(await pathExists(fixture.root)).toBeFalse();
    });
  }, 30_000);

  test('SIGKILLed master preserves A during lease expiry, rejects stale commands, then mutates to B', async () => {
    const testDeadline = Date.now() + 90_000;
    const remainingTestTime = (): number => Math.max(1, testDeadline - Date.now());
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-adopt-');
    const port = await freePort(cleanupScope);
    const first = spawnMaster(cleanupScope, entry, fixture, port);
    const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const serviceId = 'aaaaaaaa-0000-4000-8000-000000000001';
    const routeId = 'bbbbbbbb-0000-4000-8000-000000000001';
    const endpointA = 'cccccccc-0000-4000-8000-000000000001';
    const endpointB = 'dddddddd-0000-4000-8000-000000000001';
    const upstreamA = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('upstream-A', { headers: { 'x-fixture-upstream': 'A' } }) });
    const upstreamB = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('upstream-B', { headers: { 'x-fixture-upstream': 'B' } }) });
    if (upstreamA.port === undefined || upstreamB.port === undefined) throw new Error('upstream port is unavailable');
    const aggregate = (endpointId: string, targetPort: number): ConfigurationAggregateV2 => ({
      plugin_activations: [],
      logical_configuration: {
        auth: { enabled: true, tokens: [token] }, plugins: [],
        services: [{ id: serviceId, position: 1, name: 'adoption-service', plugins: [], endpoints: [{
          id: endpointId, position: 1, target: `http://127.0.0.1:${targetPort}`, weight: 100, priority: 1, is_disabled: false, plugins: [],
        }] }],
        routes: [{ id: routeId, position: 1, path: '/proxy', service_id: serviceId, auth: { enabled: false, tokens: [] }, plugins: [] }],
      },
    });
    let firstWorkers: readonly number[] = [];
    let firstDescriptors: readonly WorkerDescriptor[] = [];
    let firstAdmission: AdmissionSet | null = null;
    let firstIngressPid: number | undefined;
    let second: RunningMaster | null = null;
    await runWithCleanup(async () => {
      await waitForHealth(port, first);
      const firstState = supervisionState(fixture.dbPath);
      const ingressBase = `http://127.0.0.1:${port + 2}`;
      const ingressIdentity = await discoverIngressIdentity(ingressBase, fetch, 5_000);
      if (process.platform !== 'darwin') {
        firstIngressPid = await ingressPid(first.child.pid!);
        const ingressProof = await captureProcessIdentity(firstIngressPid);
        if (ingressProof === null) throw new Error('initial ingress identity is unavailable');
        expect(first.processes.registerAdoptedIngress(firstIngressPid, [port + 1, port + 2], ingressProof)).toBe(firstIngressPid);
      }
      const ingressCredential = deriveSupervisionProcessKey(
        MASTER_ROOT_KEY, firstState.instance_id, 'ingress', ingressIdentity.process_instance_id, ingressIdentity.boot_nonce,
      );
      const firstIngress = new IngressControllerClient({ baseUrl: ingressBase, credential: ingressCredential });
      const initialMutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(endpointA, upstreamA.port!),
          mutation_id: '71000000-0000-4000-8000-000000000001' }),
      });
      expect(initialMutation.status).toBe(202);
      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/71000000-0000-4000-8000-000000000001`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const body = await response.json() as { operation?: { state?: string } };
        if (body.operation?.state === undefined) console.error('initial operation body', JSON.stringify(body));
        return body.operation?.state === 'converged';
      }, 'initial adoption fixture mutation did not finish', 20_000);
      await businessRequests(port + 1, 'upstream-A', 'A');
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      firstWorkers = await waitForWorkerPids(first, 2);
      firstDescriptors = await waitForWorkerDescriptors(fixture, 2);
      firstDescriptors.forEach(assertCompleteReadyDescriptor);
      expect(firstDescriptors.map((descriptor) => descriptor.pid)).toEqual(expect.arrayContaining(firstWorkers));
      const firstAuthority: Authority = {
        controller_epoch: firstState.controller_epoch, controller_id: firstState.controller_id,
      };
      let firstIngressSequence = 100_000;
      const preKillStatus = await supervisionCall('master1 pre-kill status', () => firstIngress.status(firstAuthority, firstIngressSequence++));
      firstAdmission = preKillStatus.registry.active;
      expect(firstAdmission).not.toBeNull();
      const leaseExpiresAt = Date.now() + 1_500;
      await supervisionCall('master1 lease', () => firstIngress.lease(firstAuthority, leaseExpiresAt, firstIngressSequence++));
      expect(Date.now()).toBeLessThan(leaseExpiresAt);
      await first.synchronizeOwnership();
      first.child.kill('SIGKILL');
      expect((await waitForExit(first.child)).signal).toBe('SIGKILL');
      expect(firstWorkers.every(processAlive)).toBeTrue();
      if (process.platform === 'darwin') {
        expect(await discoverIngressIdentity(ingressBase, fetch, 5_000)).toEqual(ingressIdentity);
        let adoptedIngress: { readonly pid: number; readonly identity: ProcessIdentitySnapshot } | undefined;
        await waitUntil(async () => {
          const marker = `--bungee-process-identity=${ingressIdentity.process_instance_id}`;
          const candidates = (await captureProcessSnapshot()).filter((candidate) =>
            candidate.commandLine.split(/\s+/u).filter((argument) => argument === marker).length === 1);
          if (candidates.length !== 1) return false;
          const candidate = candidates[0]!;
          const exactIdentity = await captureProcessIdentity(candidate.pid);
          if (exactIdentity === null || exactIdentity.ppid === first.child.pid) return false;
          if (!processIdentityMatches(candidate, exactIdentity, 'darwin')) return false;
          const markers = await captureMacProcessMarkers(candidate.pid);
          if (markers.roleMarker !== 'ingress' || markers.testMarker !== first.testMarker) return false;
          adoptedIngress = { pid: candidate.pid, identity: exactIdentity };
          return true;
        }, 'Darwin did not expose the reparented authenticated ingress identity', 10_000);
        if (adoptedIngress === undefined) throw new Error('Darwin adopted ingress identity is unavailable');
        expect(first.processes.registerAdoptedIngress(adoptedIngress.pid, [port + 1, port + 2], adoptedIngress.identity)).toBe(adoptedIngress.pid);
        firstIngressPid = adoptedIngress.pid;
      }
      await waitUntil(async () => {
        if (Date.now() <= leaseExpiresAt) return false;
        return (await supervisionCall('master1 frozen status', () => firstIngress.status(firstAuthority, firstIngressSequence++))).state === 'frozen';
      }, 'ingress did not freeze after the explicit lease deadline', 10_000);
      await businessRequests(port + 1, 'upstream-A', 'A');
      const frozen = await supervisionCall('master1 final status', () => firstIngress.status(firstAuthority, firstIngressSequence++));
      expect(frozen.registry.prepared).toBeNull();
      expect(frozen.registry.active).not.toBeNull();
      expect(admissionSetIdentity(frozen.registry.active!)).toBe(admissionSetIdentity(firstAdmission!));
      second = spawnMaster(cleanupScope, entry, fixture, port);
      await waitForHealth(port, second);
      if (second.child.pid === undefined) throw new Error('second master PID is unavailable');
      const secondState = supervisionState(fixture.dbPath);
      const secondAuthority: Authority = {
        controller_epoch: secondState.controller_epoch, controller_id: secondState.controller_id,
      };
      expect(secondState.controller_epoch).toBe(firstAuthority.controller_epoch + 1);
      expect(secondState.controller_id).not.toBe(firstAuthority.controller_id);
      expect(firstIngressPid).toBeDefined();
      expect(processAlive(firstIngressPid!)).toBeTrue();
      expect(await discoverIngressIdentity(ingressBase, fetch, 5_000)).toEqual(ingressIdentity);
      if (process.platform === 'darwin') {
        const secondIngressCredential = deriveSupervisionProcessKey(
          MASTER_ROOT_KEY, secondState.instance_id, 'ingress', ingressIdentity.process_instance_id, ingressIdentity.boot_nonce,
        );
        const secondAdoptionIngress = new IngressControllerClient({ baseUrl: ingressBase, credential: secondIngressCredential });
        expect((await secondAdoptionIngress.status(secondAuthority, 90_000)).state).toBe('attached');
      }
      const secondDescriptors = await waitForWorkerDescriptors(fixture, 2);
      secondDescriptors.forEach(assertCompleteReadyDescriptor);
      expect(secondDescriptors.map(descriptorSnapshot)).toEqual(firstDescriptors.map(descriptorSnapshot));
      expect(secondDescriptors.map((descriptor) => descriptor.pid)).toEqual(firstDescriptors.map((descriptor) => descriptor.pid));
      const secondChildren = await childPids(second.child.pid);
      const secondWorkers = (await Promise.all(secondChildren.map(async (pid) => (await isWorkerProcess(pid)) ? pid : null)))
        .filter((pid): pid is number => pid !== null);
      expect(secondWorkers).toHaveLength(0);
      expect(firstWorkers.every(processAlive)).toBeTrue();
      const oldDescriptor = firstDescriptors[0]!;
      const oldWorkerSeed = deriveWorkerSupervisionSeed(
        MASTER_ROOT_KEY, String(oldDescriptor.master_generation), String(oldDescriptor.worker_instance_id), Number(oldDescriptor.worker_slot),
      );
      const oldWorkerCredential = deriveWorkerSupervisionCredential(oldWorkerSeed, String(oldDescriptor.boot_nonce));
      const readyEvidence = oldDescriptor.evidence as { message?: Record<string, unknown> };
      const publication = readyEvidence.message?.publication;
      if (publication === undefined) throw new Error('ready worker evidence has no publication');
      const workerBeforeStale = await signedWorkerStatus(
        `http://127.0.0.1:${String(oldDescriptor.control_port)}`, oldWorkerCredential, secondAuthority, 100_000,
      );
      const staleWorker = await signedCommand(`http://127.0.0.1:${String(oldDescriptor.control_port)}`, oldWorkerCredential, firstAuthority, 100_001, '/drain', {
        command: 'drain-worker', master_generation: oldDescriptor.master_generation, worker_instance_id: oldDescriptor.worker_instance_id,
        worker_slot: oldDescriptor.worker_slot, revision: oldDescriptor.revision, content_hash: oldDescriptor.content_hash,
        plugin_catalog_hash: oldDescriptor.plugin_catalog_hash, publication,
      });
      expect(staleWorker.response.status).toBe(409);
      expect(staleWorker.payload.error).toBe('stale_controller');
      const workerAfterStale = await signedWorkerStatus(
        `http://127.0.0.1:${String(oldDescriptor.control_port)}`, oldWorkerCredential, secondAuthority, 100_001,
      );
      expect(workerAfterStale.responseSequence).toBeGreaterThan(workerBeforeStale.responseSequence);
      expect(workerRuntimeSnapshot(workerAfterStale.body)).toEqual(workerRuntimeSnapshot(workerBeforeStale.body));
      const current = await (await fetch(`http://127.0.0.1:${port}/api/config`, {
        headers: { authorization: `Bearer ${token}` },
      })).json() as { revision: number; config: ConfigurationAggregateV2 };
      const mutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: current.revision, aggregate: aggregate(endpointB, upstreamB.port!),
          mutation_id: '71000000-0000-4000-8000-000000000002' }),
      });
      expect(mutation.status).toBe(202);
      const mutationBody = await mutation.json() as { operation_id?: string };
      expect(mutationBody.operation_id).toBeDefined();
      type OperationBody = {
        readonly operation?: { state?: string; result_status?: number | null; error_code?: string; retired_without_exit_proof?: boolean };
        readonly [key: string]: unknown;
      };
      let terminal: OperationBody = {};
      try {
        await waitUntil(async () => {
          const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/${mutationBody.operation_id}`, {
            headers: { authorization: `Bearer ${token}` },
          });
          terminal = await response.json() as OperationBody;
          return terminal.operation?.state === 'converged' || terminal.operation?.state === 'degraded';
        }, 'adopted-worker mutation did not finish', remainingTestTime());
      } catch (error) {
        const latestDescriptors = await readWorkerDescriptors(fixture).catch(() => [] as readonly Record<string, unknown>[]);
        const secondPid = second?.child.pid;
        const currentChildren = secondPid === undefined ? [] : await childPids(secondPid).catch(() => [] as number[]);
        const diagnostics = {
          last_operation_body: terminal,
          last_operation_state: terminal.operation?.state ?? null,
          descriptors: latestDescriptors,
          old_pids: [...firstWorkers].sort((a, b) => a - b),
          new_pids: [...new Set([
            ...latestDescriptors.map((descriptor) => Number(descriptor.pid)).filter(Number.isSafeInteger),
            ...currentChildren,
          ])].sort((a, b) => a - b),
          master_output: { first: first.output(), second: second?.output() ?? null },
        };
        throw new Error(`adopted-worker mutation did not finish: ${JSON.stringify(diagnostics)}`, { cause: error });
      }
      expect(terminal.operation?.state).toBe('degraded');
      expect(terminal.operation?.result_status).toBe(202);
      expect(terminal.operation?.error_code).toBe('old_worker_drain_failed');
      if (terminal.operation !== undefined && 'retired_without_exit_proof' in terminal.operation) {
        expect(terminal.operation.retired_without_exit_proof).toBeTrue();
      }
      expect(revision(fixture.dbPath)).toBe(current.revision + 1);
      const finalDescriptors = await waitForWorkerDescriptors(fixture, 2);
      finalDescriptors.forEach(assertCompleteReadyDescriptor);
      expect(finalDescriptors.map((descriptor) => descriptor.worker_instance_id)
        .some((id) => firstDescriptors.some((old) => old.worker_instance_id === id))).toBeFalse();
      expect(finalDescriptors.map((descriptor) => descriptor.pid)
        .some((pid) => firstDescriptors.some((old) => old.pid === pid))).toBeFalse();
      const secondIngress = new IngressControllerClient({ baseUrl: ingressBase, credential: ingressCredential });
      const ingressBeforeStale = await supervisionCall('master2 status before stale commands', () => secondIngress.status(secondAuthority, 100_000));
      const staleIngress = await signedCommand(ingressBase, ingressCredential, firstAuthority, 100_001, '/admission/fence', null);
      expect(staleIngress.response.status).toBe(409);
      expect(staleIngress.payload.error).toBe('stale_controller');
      const ingressAfterStale = await supervisionCall('master2 status after stale commands', () => secondIngress.status(secondAuthority, 100_001));
      const finalStatus = ingressAfterStale;
      expect({ active: finalStatus.registry.active, prepared: finalStatus.registry.prepared, retired: finalStatus.registry.retired })
        .toEqual({ active: ingressBeforeStale.registry.active, prepared: ingressBeforeStale.registry.prepared, retired: ingressBeforeStale.registry.retired });
      expect(finalStatus).toMatchObject({ state: 'attached', registry: { prepared: null } });
      expect(finalStatus.registry.active?.revision).toBe(current.revision + 1);
      const finalContentHash = finalDescriptors[0]?.content_hash as `sha256:${string}`;
      const finalPluginCatalogHash = finalDescriptors[0]?.plugin_catalog_hash as `sha256:${string}`;
      expect(finalStatus.registry.active?.content_hash).toBe(finalContentHash);
      expect(finalStatus.registry.active?.plugin_catalog_hash).toBe(finalPluginCatalogHash);
      expect(new Set(finalDescriptors.map((descriptor) => descriptor.content_hash)).size).toBe(1);
      expect(new Set(finalDescriptors.map((descriptor) => descriptor.plugin_catalog_hash)).size).toBe(1);
      expect(firstAdmission).not.toBeNull();
      expect(finalStatus.registry.retired.some((candidate) => admissionSetIdentity(candidate) === admissionSetIdentity(firstAdmission!))).toBeTrue();
      expect(finalStatus.registry.active?.workers.map(({ master_generation, worker_instance_id, boot_nonce, worker_slot, private_port }) =>
        ({ master_generation, worker_instance_id, boot_nonce, worker_slot, private_port })).sort((a, b) => a.worker_slot - b.worker_slot)).toEqual(
        finalDescriptors.map((descriptor) => ({
          master_generation: String(descriptor.master_generation), worker_instance_id: String(descriptor.worker_instance_id),
          boot_nonce: String(descriptor.boot_nonce), worker_slot: Number(descriptor.worker_slot), private_port: Number(descriptor.private_port),
        })).sort((a, b) => a.worker_slot - b.worker_slot),
      );
      const secondMutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: current.revision + 1, aggregate: aggregate(endpointB, upstreamB.port!), mutation_id: '71000000-0000-4000-8000-000000000003' }),
      });
      expect(secondMutation.status).toBe(503);
      expect(await secondMutation.json()).toEqual({ error: 'control_recovering' });
      const finalSnapshot = await (await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${token}` } })).json() as { revision: number; config: ConfigurationAggregateV2 };
      expect(finalSnapshot.revision).toBe(current.revision + 1);
      expect(finalStatus.registry.active?.content_hash).toBe(hashConfigurationContent(finalSnapshot.config));
      await businessRequests(port + 1, 'upstream-B', 'B');
    }, async () => {
      const failures: unknown[] = [];
      const masterResults = await Promise.allSettled([
        ...(second === null ? [] : [cleanupMaster({ ...second, ports: [second.ports[0]!], ingressPorts: [], workerCount: 0 })]),
        cleanupMaster(first, firstWorkers),
      ]);
      failures.push(...masterResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
      const resourceResults = await Promise.allSettled([upstreamA.stop(true), upstreamB.stop(true)]);
      failures.push(...resourceResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
      if (failures.length === 0) {
        try { await removeFixture(fixture); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'adoption cleanup failed');
    });
  }, 90_000);

  test('descriptor tampering leaves the active ingress read-only without killing workers', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-reclaim-');
    const port = await freePort(cleanupScope);
    const first = spawnMaster(cleanupScope, entry, fixture, port);
    const token = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const serviceId = 'eeeeeeee-0000-4000-8000-000000000001';
    const routeId = 'ffffffff-0000-4000-8000-000000000001';
    const endpointA = '11111111-0000-4000-8000-000000000001';
    const upstreamA = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('upstream-A', { headers: { 'x-fixture-upstream': 'A' } }) });
    if (upstreamA.port === undefined) throw new Error('upstream port is unavailable');
    const aggregate = (targetPort: number): ConfigurationAggregateV2 => ({
      plugin_activations: [],
      logical_configuration: {
        auth: { enabled: true, tokens: [token] }, plugins: [],
        services: [{ id: serviceId, position: 1, name: 'readonly-service', plugins: [], endpoints: [{
          id: endpointA, position: 1, target: `http://127.0.0.1:${targetPort}`, weight: 100, priority: 1, is_disabled: false, plugins: [],
        }] }],
        routes: [{ id: routeId, position: 1, path: '/proxy', service_id: serviceId, auth: { enabled: false, tokens: [] }, plugins: [] }],
      },
    });
    let firstWorkers: readonly number[] = [];
    let firstDescriptors: readonly WorkerDescriptor[] = [];
    let firstAdmission: AdmissionSet | null = null;
    let second: RunningMaster | null = null;
    let descriptorBackup: string | undefined;
    let descriptorSentinel: string | undefined;
    await runWithCleanup(async () => {
      await waitForHealth(port, first);
      const firstState = supervisionState(fixture.dbPath);
      const ingressBase = `http://127.0.0.1:${port + 2}`;
      const ingressIdentity = await discoverIngressIdentity(ingressBase, fetch, 5_000);
      const firstIngress = new IngressControllerClient({
        baseUrl: ingressBase,
        credential: deriveSupervisionProcessKey(MASTER_ROOT_KEY, firstState.instance_id, 'ingress', ingressIdentity.process_instance_id, ingressIdentity.boot_nonce),
      });
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      firstWorkers = await waitForWorkerPids(first, 2);
      const initialMutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: 1, aggregate: aggregate(upstreamA.port!), mutation_id: '72000000-0000-4000-8000-000000000001' }),
      });
      expect(initialMutation.status).toBe(202);
      await waitUntil(async () => {
        const response = await fetch(`http://127.0.0.1:${port}/api/config/operations/72000000-0000-4000-8000-000000000001`, { headers: { authorization: `Bearer ${token}` } });
        return ((await response.json()) as { operation?: { state?: string } }).operation?.state === 'converged';
      }, 'readonly fixture mutation did not finish', 20_000);
      await businessRequests(port + 1, 'upstream-A', 'A');
      firstDescriptors = await waitForWorkerDescriptors(fixture, 2);
      firstDescriptors.forEach(assertCompleteReadyDescriptor);
      firstWorkers = firstDescriptors.map((descriptor) => Number(descriptor.pid));
      expect(firstWorkers).toHaveLength(2);
      expect(firstWorkers.every(processAlive)).toBeTrue();
      const firstAuthority: Authority = { controller_epoch: firstState.controller_epoch, controller_id: firstState.controller_id };
      const leaseExpiresAt = Date.now() + 1_500;
      const firstStatus = await supervisionCall('readonly master1 status', () => firstIngress.status(firstAuthority, 100_000));
      firstAdmission = firstStatus.registry.active;
      expect(firstAdmission).not.toBeNull();
      await supervisionCall('readonly master1 lease', () => firstIngress.lease(firstAuthority, leaseExpiresAt, 100_001));
      expect(Date.now()).toBeLessThan(leaseExpiresAt);
      await first.synchronizeOwnership();
      first.child.kill('SIGKILL');
      expect((await waitForExit(first.child)).signal).toBe('SIGKILL');
      const descriptor = firstDescriptors[0]!;
      const descriptorPath = join(fixture.root, 'data', 'runtime', 'workers', `${descriptor.worker_instance_id}.json`);
      descriptorBackup = `${descriptorPath}.backup`;
      await rename(descriptorPath, descriptorBackup);
      descriptorSentinel = descriptorPath;
      await mkdir(descriptorSentinel);
      await waitUntil(() => Date.now() >= leaseExpiresAt + 500,
        'readonly lease expiry plus cleanup margin was not reached', 10_000);
      await businessRequests(port + 1, 'upstream-A', 'A');

      second = spawnMaster(cleanupScope, entry, fixture, port);
      await waitForHealth(port, second);
      const secondState = supervisionState(fixture.dbPath);
      const secondAuthority: Authority = { controller_epoch: secondState.controller_epoch, controller_id: secondState.controller_id };
      const secondIngress = new IngressControllerClient({
        baseUrl: ingressBase,
        credential: deriveSupervisionProcessKey(MASTER_ROOT_KEY, firstState.instance_id, 'ingress', ingressIdentity.process_instance_id, ingressIdentity.boot_nonce),
      });
      const readonlyStatus = await supervisionCall('readonly master2 status', () => secondIngress.status(secondAuthority, 100_000));
      expect(readonlyStatus).toMatchObject({ state: 'attached', registry: { prepared: null } });
      expect(readonlyStatus.registry.active?.revision).toBe(firstAdmission!.revision);
      expect(readonlyStatus.registry.active?.workers.map(({ master_generation, worker_instance_id, boot_nonce, worker_slot, private_port }) =>
        ({ master_generation, worker_instance_id, boot_nonce, worker_slot, private_port }))).toEqual([...firstAdmission!.workers]);
      expect(firstWorkers.every(processAlive)).toBeTrue();
      const survivingDescriptors = await readWorkerDescriptors(fixture);
      expect(survivingDescriptors).toHaveLength(1);
      expect(survivingDescriptors[0]?.worker_instance_id).toBe(firstDescriptors.find((candidate) => candidate.worker_instance_id !== descriptor.worker_instance_id)?.worker_instance_id);
      const secondChildren = second.child.pid === undefined ? [] : await childPids(second.child.pid);
      expect((await Promise.all(secondChildren.map(async (pid) => (await isWorkerProcess(pid)) ? pid : null)))
        .filter((pid): pid is number => pid !== null)).toHaveLength(0);
      await businessRequests(port + 1, 'upstream-A', 'A');
      const read = await fetch(`http://127.0.0.1:${port}/api/config`, { headers: { authorization: `Bearer ${token}` } });
      expect(read.status).toBe(200);
      const current = await read.json() as { revision: number; config: ConfigurationAggregateV2 };
      const mutation = await fetch(`http://127.0.0.1:${port}/api/config`, {
        method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-bungee-next-authorization': `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ expected_revision: current.revision, aggregate: current.config,
          mutation_id: '72000000-0000-4000-8000-000000000002' }),
      });
      expect(mutation.status).toBe(503);
      expect(await mutation.json()).toEqual({ error: 'control_recovering' });
      await businessRequests(port + 1, 'upstream-A', 'A');
      expect(survivingDescriptors.map(descriptorSnapshot)).toEqual(
        firstDescriptors.filter((candidate) => candidate.worker_instance_id !== descriptor.worker_instance_id).map(descriptorSnapshot),
      );
    }, async () => {
      const failures: unknown[] = [];
      const evidenceResults = await Promise.allSettled([restoreDescriptorBackups(
        descriptorBackup === undefined ? [] : [{ path: descriptorSentinel ?? descriptorBackup.slice(0, -'.backup'.length), backup: descriptorBackup }],
        descriptorSentinel === undefined ? [] : [descriptorSentinel],
      )]);
      failures.push(...evidenceResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
      const masterResults = await Promise.allSettled([
        ...(second === null ? [] : [cleanupMaster({ ...second, ports: [second.ports[0]!], ingressPorts: [], workerCount: 0 })]),
        cleanupMaster(first, firstWorkers),
      ]);
      failures.push(...masterResults.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
      const upstreamResult = await Promise.allSettled([upstreamA.stop(true)]);
      failures.push(...upstreamResult.flatMap((result) => result.status === 'rejected' ? [result.reason] : []));
      if (failures.length === 0) {
        try { await removeFixture(fixture); } catch (error) { failures.push(error); }
      }
      if (failures.length > 0) throw new AggregateError(failures, 'readonly adoption cleanup failed');
    });
  }, 90_000);
});
