import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildMasterEntries,
  childPids,
  cleanupMaster,
  createMasterFixture,
  expectPortClosed,
  freePort,
  pathExists,
  processAlive,
  removeFixture,
  spawnMaster,
  waitForDead,
  waitForExit,
  waitForHealth,
  waitForWorkerPids,
  waitUntil,
  type MasterEntry,
  type RunningMaster,
} from '../fixtures/master-real-process-harness';

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

beforeAll(async () => {
  buildRoot = await mkdtemp(join(tmpdir(), 'bungee-master-build-'));
  entries = await buildMasterEntries(buildRoot);
}, 120_000);

afterAll(async () => {
  if (buildRoot !== undefined) await rm(buildRoot, { recursive: true, force: true });
});

describe.serial('real SQLite master process', () => {
  test('source, fresh dist, and compiled entries start at revision one and shut down cleanly', async () => {
    for (const entry of entries) {
      const fixture = await createMasterFixture(`bungee-master-${entry.name}-`);
      const port = await freePort();
      const master = spawnMaster(entry, fixture, port);
      let workers: readonly number[] = [];
      try {
        await waitForHealth(port, master);
        if (master.child.pid === undefined) throw new Error('master PID is unavailable');
        workers = await waitForWorkerPids(master.child.pid, 2);
        expect(new Set(workers).size).toBe(2);
        expect(workers.every(processAlive)).toBeTrue();
        expect(await pathExists(fixture.accessDbPath)).toBeTrue();
        expect(await pathExists(`${fixture.accessDbPath}.lock`)).toBeTrue();
        expect(await pathExists(join(fixture.root, 'logs', 'access.db'))).toBeFalse();
        expect(revision(fixture.dbPath)).toBe(1);

        await writeFile(fixture.configPath, '{still invalid', 'utf8');
        await Bun.sleep(300);
        expect(await childPids(master.child.pid)).toEqual(workers);
        expect(revision(fixture.dbPath)).toBe(1);
        await waitForHealth(port, master);

        master.child.kill('SIGTERM');
        expect(await waitForExit(master.child)).toEqual({ code: 0, signal: null });
        await waitForDead(workers);
        await expectPortClosed(port);
        expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
        expect(await pathExists(`${fixture.accessDbPath}.lock`)).toBeTrue();
      } finally {
        await cleanupMaster(master, workers);
        await removeFixture(fixture);
      }
    }
  }, 90_000);

  test('repairs a killed admitted worker without interrupting the master listener', async () => {
    const fixture = await createMasterFixture('bungee-master-repair-');
    const port = await freePort();
    const master = spawnMaster(entries[0], fixture, port);
    let ownedPids: readonly number[] = [];
    try {
      await waitForHealth(port, master);
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      const masterPid = master.child.pid;
      const initialPids = await waitForWorkerPids(masterPid, 2);
      ownedPids = initialPids;
      const killedPid = initialPids[0];
      process.kill(killedPid, 'SIGKILL');
      await waitForDead([killedPid]);

      let repairedPids: readonly number[] = [];
      await waitUntil(async () => {
        expect(master.child.exitCode).toBeNull();
        expect(master.child.signalCode).toBeNull();
        const health = await fetch(`http://127.0.0.1:${port}/health`, {
          headers: { connection: 'close' },
          signal: AbortSignal.timeout(250),
        });
        expect(health.status).toBe(200);
        repairedPids = await childPids(masterPid);
        return repairedPids.length === 2
          && !repairedPids.includes(killedPid)
          && repairedPids.every(processAlive);
      }, `master did not repair worker ${killedPid}: ${master.output()}`, 10_000);

      ownedPids = [...new Set([...initialPids, ...repairedPids])];
      expect(repairedPids).toHaveLength(2);
      expect(repairedPids).not.toContain(killedPid);
      await waitForHealth(port, master);
    } finally {
      await cleanupMaster(master, ownedPids);
      await removeFixture(fixture);
    }
  }, 30_000);

  test('rejects a concurrent master for the same database without disturbing the owner', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-lock-');
    const firstPort = await freePort();
    const secondPort = await freePort();
    const first = spawnMaster(entry, fixture, firstPort);
    let second: RunningMaster | null = null;
    let workers: readonly number[] = [];
    try {
      await waitForHealth(firstPort, first);
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      workers = await waitForWorkerPids(first.child.pid, 2);
      second = spawnMaster(entry, fixture, secondPort);
      const secondExit = await waitForExit(second.child);
      expect(secondExit.code).not.toBe(0);
      expect(second.output()).toContain('"code":"held"');
      expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
      await waitForHealth(firstPort, first);
      await expectPortClosed(secondPort);
    } finally {
      if (second !== null) await cleanupMaster(second);
      await cleanupMaster(first, workers);
      await removeFixture(fixture);
    }
  }, 30_000);

  test('rejects different config databases that share one access database', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const firstFixture = await createMasterFixture('bungee-master-access-owner-');
    const secondFixture = await createMasterFixture('bungee-master-access-contender-');
    const firstPort = await freePort();
    const secondPort = await freePort();
    const accessLockPath = `${firstFixture.accessDbPath}.lock`;
    const first = spawnMaster(entry, firstFixture, firstPort);
    let second: RunningMaster | null = null;
    let workers: readonly number[] = [];
    try {
      await waitForHealth(firstPort, first);
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      workers = await waitForWorkerPids(first.child.pid, 2);
      second = spawnMaster(entry, secondFixture, secondPort, 2, firstFixture.root, firstFixture.accessDbPath);

      expect((await waitForExit(second.child)).code).toBe(1);
      expect(second.output()).toContain('access.db.lock');
      expect(await pathExists(`${secondFixture.dbPath}.lock`)).toBeTrue();
      expect(await pathExists(accessLockPath)).toBeTrue();
      await waitForHealth(firstPort, first);

      first.child.kill('SIGTERM');
      expect(await waitForExit(first.child)).toEqual({ code: 0, signal: null });
      await waitForDead(workers);
      expect(await pathExists(accessLockPath)).toBeTrue();
    } finally {
      if (second !== null) await cleanupMaster(second);
      await cleanupMaster(first, workers);
      await removeFixture(secondFixture);
      await removeFixture(firstFixture);
    }
  }, 30_000);

  test('occupied public port fails startup after cleaning workers, repository, and lock', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-port-');
    const occupied = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('occupied') });
    const occupiedPort = occupied.port;
    if (occupiedPort === undefined) throw new Error('occupied server did not expose a port');
    const master = spawnMaster(entry, fixture, occupiedPort);
    const observed = new Set<number>();
    try {
      if (master.child.pid === undefined) throw new Error('master PID is unavailable');
      while (master.child.exitCode === null && master.child.signalCode === null) {
        for (const pid of await childPids(master.child.pid)) observed.add(pid);
        await Bun.sleep(10);
      }
      const result = await waitForExit(master.child);
      expect(result.code).not.toBe(0);
      await waitForDead([...observed]);
      expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
      expect(revision(fixture.dbPath)).toBe(1);
      const inspector = new Database(fixture.dbPath, { readwrite: true, strict: true });
      inspector.close(true);
    } finally {
      await occupied.stop(true);
      await cleanupMaster(master, [...observed]);
      await expectPortClosed(occupiedPort);
      await removeFixture(fixture);
    }
  }, 30_000);

  test('SIGKILL orphans exit and the next master reclaims the stale lock', async () => {
    const entry = entries[0];
    if (entry === undefined) throw new Error('source entry is unavailable');
    const fixture = await createMasterFixture('bungee-master-reclaim-');
    const port = await freePort();
    const first = spawnMaster(entry, fixture, port);
    let firstWorkers: readonly number[] = [];
    let secondWorkers: readonly number[] = [];
    let second = spawnMaster(entry, fixture, await freePort());
    second.child.kill('SIGKILL');
    await waitForExit(second.child);
    try {
      await waitForHealth(port, first);
      if (first.child.pid === undefined) throw new Error('first master PID is unavailable');
      firstWorkers = await waitForWorkerPids(first.child.pid, 2);
      first.child.kill('SIGKILL');
      expect((await waitForExit(first.child)).signal).toBe('SIGKILL');
      expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
      await waitForDead(firstWorkers);
      await expectPortClosed(port);

      second = spawnMaster(entry, fixture, port);
      await waitForHealth(port, second);
      if (second.child.pid === undefined) throw new Error('second master PID is unavailable');
      secondWorkers = await waitForWorkerPids(second.child.pid, 2);
      expect(await pathExists(`${fixture.dbPath}.lock`)).toBeTrue();
      expect(secondWorkers.some((pid) => firstWorkers.includes(pid))).toBeFalse();
    } finally {
      await cleanupMaster(second, secondWorkers);
      await cleanupMaster(first, firstWorkers);
      await removeFixture(fixture);
    }
  }, 30_000);
});
