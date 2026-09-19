import { afterEach, describe, expect, test } from 'bun:test';
import { constants as sqliteConstants, Database } from 'bun:sqlite';
import { lstat, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  acquireMasterInstanceLock, consumeControllerClaimCapability, mintControllerClaimCapability, MasterInstanceLockError,
} from '../../src/master-runtime/instance-lock';
import { makeCanonicalTempDir } from '../../../../tests/support/canonical-temp';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })));
});

async function lockPath(name = 'runtime/bungee.lock'): Promise<string> {
  const directory = makeCanonicalTempDir('bungee-master-lock');
  directories.push(directory);
  return join(directory, name);
}

async function expectLockFailure(path: string, code: 'held' | 'invalid'): Promise<MasterInstanceLockError> {
  try {
    await acquireMasterInstanceLock(path);
    throw new Error('expected lock acquisition to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(MasterInstanceLockError);
    if (!(error instanceof MasterInstanceLockError)) throw error;
    expect(error.code).toBe(code);
    return error;
  }
}

describe('master cross-process instance lock', () => {
  test('mints one controller claim only from two held lock objects', async () => {
    const configPath = await lockPath('config/bungee.lock');
    const accessPath = await lockPath('access/bungee.lock');
    const config = await acquireMasterInstanceLock(configPath);
    const access = await acquireMasterInstanceLock(accessPath);
    const capability = mintControllerClaimCapability(config, access);

    expect(consumeControllerClaimCapability(capability, () => 'claimed')).toBe('claimed');
    expect(() => consumeControllerClaimCapability(capability, () => 'repeated')).toThrow(MasterInstanceLockError);
    expect(() => mintControllerClaimCapability(config, access)).toThrow(MasterInstanceLockError);

    await access.release();
    await config.release();
    expect(() => mintControllerClaimCapability(config, access)).toThrow(MasterInstanceLockError);
  });

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

  test('acquires through a lexical path whose parent is already canonical', async () => {
    const lexicalRoot = makeCanonicalTempDir('bungee-master-lock-lexical');
    directories.push(lexicalRoot);
    const canonicalRoot = await realpath(lexicalRoot);
    const path = join(lexicalRoot, 'bungee.lock');

    const owner = await acquireMasterInstanceLock(path);
    expect(owner.path).toBe(path);
    expect(await realpath(dirname(path))).toBe(canonicalRoot);
    await owner.release();
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
    expect((await expectLockFailure(path, 'invalid')).path).toBe(path);
    expect(await readFile(target, 'utf8')).toBe('outside');
    await rm(path);

    await mkdir(path);
    expect((await expectLockFailure(path, 'invalid')).path).toBe(path);
    expect((await lstat(path)).isDirectory()).toBeTrue();
    await rm(path, { recursive: true });

    const physicalParent = join(dirname(path), 'physical-parent');
    const linkedParent = join(dirname(path), 'linked-parent');
    await mkdir(physicalParent);
    await symlink(physicalParent, linkedParent);
    const linkedPath = join(linkedParent, 'bungee.lock');
    expect((await expectLockFailure(linkedPath, 'invalid')).path).toBe(linkedPath);
    expect(await readdir(physicalParent)).toEqual([]);
  });
});
