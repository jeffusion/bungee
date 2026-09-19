import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, readFile, symlink, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteLegacyPidFile, readLegacyPidFile, writeLegacyPidMirror } from './pid-mirror';
import { makeCanonicalTempDir } from './test-support';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }))); });

describe('legacy PID mirror', () => {
  test('replaces a symlink entry without following it and preserves hardlink victims', async () => {
    const directory = makeCanonicalTempDir('bungee-pid-mirror');
    directories.push(directory);
    const target = join(directory, 'bungee.pid');
    const symlinkVictim = join(directory, 'symlink-victim');
    await writeFile(symlinkVictim, 'victim');
    await symlink(symlinkVictim, target);
    await writeLegacyPidMirror(target, 1234);
    expect(await readFile(symlinkVictim, 'utf8')).toBe('victim');
    expect((await readLegacyPidFile(target)).kind).toBe('valid');

    const hardlinkVictim = join(directory, 'hardlink-victim');
    await writeFile(hardlinkVictim, 'old');
    await rm(target);
    await link(hardlinkVictim, target);
    await writeLegacyPidMirror(target, 5678);
    expect(await readFile(hardlinkVictim, 'utf8')).toBe('old');
  });

  test('classifies hostile files and deletes only the observed regular inode', async () => {
    const directory = makeCanonicalTempDir('bungee-pid-reader');
    directories.push(directory);
    const target = join(directory, 'bungee.pid');
    const victim = join(directory, 'victim');
    await writeFile(victim, '42');
    await symlink(victim, target);
    expect(await readLegacyPidFile(target)).toEqual({ kind: 'unsafe' });
    await rm(target);
    await writeFile(target, 'not-a-pid');
    expect(await readLegacyPidFile(target)).toEqual({ kind: 'unsafe' });
    await chmod(target, 0o600);
    await writeLegacyPidMirror(target, 42);
    const read = await readLegacyPidFile(target);
    expect(read.kind).toBe('valid');
    if (read.kind !== 'valid') throw new Error('expected valid PID');
    expect(await deleteLegacyPidFile(target, read.identity)).toBe(true);
    expect(await Bun.file(target).exists()).toBe(false);
  });
});
