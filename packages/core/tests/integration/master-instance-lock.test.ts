import { afterEach, describe, expect, test } from 'bun:test';
import { constants as sqliteConstants, Database } from 'bun:sqlite';
import { spawn, type ChildProcess } from 'node:child_process';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { acquireMasterInstanceLock, MasterInstanceLockError } from '../../src/master-runtime/instance-lock';

const fixture = resolve(import.meta.dir, '../fixtures/master-instance-lock-process.ts');
const directories: string[] = [];
const children = new Set<ChildProcess>();

async function exited(child: ChildProcess): Promise<number | null> {
  if (child.exitCode !== null) return child.exitCode;
  return await new Promise((resolveExit) => child.once('exit', resolveExit));
}

async function stop(child: ChildProcess, signal: NodeJS.Signals = 'SIGKILL'): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill(signal);
  await exited(child);
}

afterEach(async () => {
  await Promise.all([...children].map((child) => stop(child)));
  children.clear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function lockPath(name = 'runtime/bungee.lock'): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'bungee-master-lock-'));
  directories.push(directory);
  return join(directory, name);
}

function start(path: string, wait = false): ChildProcess {
  const child = spawn(process.execPath, [fixture, path, ...(wait ? ['wait'] : [])], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  children.add(child);
  return child;
}

function message(child: ChildProcess, status: string): Promise<Record<string, unknown>> {
  return new Promise((resolveMessage, reject) => {
    const timeout = setTimeout(() => finish(new Error(`timed out waiting for ${status}`)), 10_000);
    const onMessage = (value: unknown) => {
      if (value !== null && typeof value === 'object' && 'status' in value && value.status === status) {
        finish(undefined, value);
      }
    };
    const onExit = () => finish(new Error(`lock fixture exited before ${status}`));
    const finish = (error?: Error, value?: Record<string, unknown>) => {
      clearTimeout(timeout);
      child.off('message', onMessage);
      child.off('exit', onExit);
      if (error !== undefined) reject(error);
      else if (value !== undefined) resolveMessage(value);
    };
    child.on('message', onMessage);
    child.once('exit', onExit);
  });
}

function send(child: ChildProcess, value: string): Promise<void> {
  return new Promise((resolveSend, reject) => {
    child.send(value, (error) => error ? reject(error) : resolveSend());
  });
}

async function expectLockFailure(path: string, code: 'held' | 'invalid'): Promise<void> {
  try {
    await acquireMasterInstanceLock(path);
    throw new Error('expected lock acquisition to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MasterInstanceLockError);
    if (!(error instanceof MasterInstanceLockError)) throw error;
    expect(error.code).toBe(code);
  }
}

describe('master cross-process instance lock', () => {
  test('publishes a SQLite lock with the required format and keeps the file', async () => {
    const path = await lockPath();
    const owner = await acquireMasterInstanceLock(path);
    await owner.release();

    const db = new Database(
      path,
      sqliteConstants.SQLITE_OPEN_READWRITE | sqliteConstants.SQLITE_OPEN_NOFOLLOW,
    );
    expect(db.query('PRAGMA application_id').get()).toEqual({ application_id: 0x42554e47 });
    expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 1 });
    expect(db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'delete' });
    expect(db.query('PRAGMA busy_timeout').get()).toEqual({ timeout: 0 });
    db.close(true);

    expect((await lstat(path)).isFile()).toBeTrue();
    expect(await readdir(dirname(path))).toEqual(['bungee.lock']);
  });

  test('reports an alive owner as held', async () => {
    const path = await lockPath();
    const owner = start(path);
    await message(owner, 'acquired');

    await expectLockFailure(path, 'held');
  });

  test('lets exactly one of two real processes acquire an empty path', async () => {
    const path = await lockPath();
    const left = start(path, true);
    const right = start(path, true);
    await Promise.all([message(left, 'ready'), message(right, 'ready')]);

    const leftResult = Promise.race([message(left, 'acquired'), message(left, 'failed')]);
    const rightResult = Promise.race([message(right, 'acquired'), message(right, 'failed')]);
    await Promise.all([send(left, 'acquire'), send(right, 'acquire')]);
    const results = await Promise.all([leftResult, rightResult]);

    expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'failed']);
    expect(results.find((result) => result.status === 'failed')?.code).toBe('held');
    expect((await readdir(dirname(path))).filter((name) => name !== 'bungee.lock')).toEqual([]);
  });

  test('lets exactly one of two in-process acquires win an empty path', async () => {
    const path = await lockPath();
    const results = await Promise.allSettled([
      acquireMasterInstanceLock(path),
      acquireMasterInstanceLock(path),
    ]);
    const acquired = results.filter((result) => result.status === 'fulfilled');
    const failed = results.filter((result) => result.status === 'rejected');

    expect(acquired).toHaveLength(1);
    expect(failed).toHaveLength(1);
    const reason = failed[0]?.reason;
    expect(reason).toBeInstanceOf(MasterInstanceLockError);
    if (!(reason instanceof MasterInstanceLockError)) throw reason;
    expect(reason.code).toBe('held');
    await acquired[0]?.value.release();
  });

  test('retains the file and can immediately reacquire after SIGKILL', async () => {
    const path = await lockPath();
    const owner = start(path);
    await message(owner, 'acquired');
    await stop(owner, 'SIGKILL');

    expect((await lstat(path)).isFile()).toBeTrue();
    const replacement = await acquireMasterInstanceLock(path);
    await replacement.release();
    expect((await lstat(path)).isFile()).toBeTrue();
  });

  test('releases the SQLite transaction on SIGTERM', async () => {
    const path = await lockPath();
    const owner = start(path);
    await message(owner, 'acquired');
    await stop(owner, 'SIGTERM');

    const replacement = await acquireMasterInstanceLock(path);
    await replacement.release();
  });

  test('release is idempotent and an old handle cannot affect a new owner', async () => {
    const path = await lockPath();
    const old = await acquireMasterInstanceLock(path);
    await Promise.all([old.release(), old.release()]);
    const current = await acquireMasterInstanceLock(path);

    await old.release();
    await expectLockFailure(path, 'held');
    await current.release();
    expect((await lstat(path)).isFile()).toBeTrue();
  });

  test('releases the config transaction when the access lock is held', async () => {
    const configPath = await lockPath('config/bungee.lock');
    const accessPath = await lockPath('access/bungee.lock');
    const config = await acquireMasterInstanceLock(configPath);
    const accessOwner = await acquireMasterInstanceLock(accessPath);

    await expectLockFailure(accessPath, 'held');
    await config.release();
    const replacement = await acquireMasterInstanceLock(configPath);
    await replacement.release();
    await accessOwner.release();
  });

  test('rejects EISDIR temporary cleanup and allows a later acquire', async () => {
    const path = await lockPath();
    let hookCalled = false;
    let replacedTemporaryPath: string | undefined;
    let acquisitionError: unknown;
    try {
      await acquireMasterInstanceLock(path, {
        afterPublish: async (temporaryPath) => {
          hookCalled = true;
          replacedTemporaryPath = temporaryPath;
          expect((await lstat(path)).isFile()).toBeTrue();
          await unlink(temporaryPath);
          await mkdir(temporaryPath);
        },
      });
    } catch (error) {
      acquisitionError = error;
    }
    expect(acquisitionError).toBeInstanceOf(MasterInstanceLockError);
    if (!(acquisitionError instanceof MasterInstanceLockError)) throw acquisitionError;
    expect(acquisitionError.code).toBe('io');
    expect(hookCalled).toBeTrue();
    if (replacedTemporaryPath === undefined) throw new Error('cleanup hook did not receive temporary path');
    expect((await lstat(replacedTemporaryPath)).isDirectory()).toBeTrue();
    await rm(replacedTemporaryPath, { recursive: true });

    const replacement = await acquireMasterInstanceLock(path);
    await replacement.release();
  });

  test('fails closed without modifying malformed or foreign lock files', async () => {
    const path = await lockPath();
    await mkdir(dirname(path), { recursive: true });
    const invalidFiles = [
      '{"pid":1,"token":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"}',
      'not sqlite',
      Buffer.from('SQLite format 3\0' + 'x'.repeat(84)),
    ];

    for (const content of invalidFiles) {
      await writeFile(path, content);
      const before = await readFile(path);
      await expectLockFailure(path, 'invalid');
      expect(await readFile(path)).toEqual(before);
      await rm(path);
    }

    const foreign = new Database(path);
    foreign.close(true);
    const foreignBytes = await readFile(path);
    await expectLockFailure(path, 'invalid');
    expect(await readFile(path)).toEqual(foreignBytes);
  });

  test('fails closed for symlinks, directories, and symlink parents', async () => {
    const path = await lockPath();
    await mkdir(dirname(path), { recursive: true });

    const target = join(dirname(path), 'target');
    await writeFile(target, 'outside');
    await symlink(target, path);
    await expectLockFailure(path, 'invalid');
    expect(await readFile(target, 'utf8')).toBe('outside');
    await rm(path);

    await mkdir(path);
    await expectLockFailure(path, 'invalid');
    expect((await lstat(path)).isDirectory()).toBeTrue();
    await rm(path, { recursive: true });

    const physicalParent = join(dirname(path), 'physical-parent');
    const linkedParent = join(dirname(path), 'linked-parent');
    await mkdir(physicalParent);
    await symlink(physicalParent, linkedParent);
    await expectLockFailure(join(linkedParent, 'bungee.lock'), 'invalid');
    expect(await readdir(physicalParent)).toEqual([]);
  });
});
