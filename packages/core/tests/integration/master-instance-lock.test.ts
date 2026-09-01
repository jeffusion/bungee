import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
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
  test('creates its parent and atomically publishes one canonical owner record', async () => {
    // Given
    const path = await lockPath();
    const owner = start(path);

    // When
    const acquired = await message(owner, 'acquired');

    // Then
    const text = await readFile(path, 'utf8');
    const record: unknown = JSON.parse(text);
    expect(record).toEqual({ pid: owner.pid, token: acquired.token });
    expect(() => process.kill(owner.pid ?? 0, 0)).not.toThrow();
    expect(text).toBe(JSON.stringify(record));
    expect((await lstat(path)).isFile()).toBeTrue();
    expect(await readdir(dirname(path))).toEqual(['bungee.lock']);
    await expectLockFailure(path, 'held');
  });

  test('releases on SIGTERM and reclaims only after SIGKILL proves the owner dead', async () => {
    // Given
    const gracefulPath = await lockPath('graceful/bungee.lock');
    const gracefulOwner = start(gracefulPath);
    await message(gracefulOwner, 'acquired');

    // When
    await stop(gracefulOwner, 'SIGTERM');

    // Then
    const replacement = await acquireMasterInstanceLock(gracefulPath);
    await replacement.release();

    // Given
    const stalePath = await lockPath('stale/bungee.lock');
    const killedOwner = start(stalePath);
    await message(killedOwner, 'acquired');
    expect(() => process.kill(killedOwner.pid ?? 0, 0)).not.toThrow();
    await expectLockFailure(stalePath, 'held');

    // When
    await stop(killedOwner, 'SIGKILL');

    // Then
    expect(() => process.kill(killedOwner.pid ?? 0, 0)).toThrow();
    const reclaimed = await acquireMasterInstanceLock(stalePath);
    await reclaimed.release();
  });

  test('allows only one of two real processes to reclaim the same stale owner', async () => {
    // Given
    const path = await lockPath();
    const owner = start(path);
    await message(owner, 'acquired');
    await stop(owner, 'SIGKILL');
    const left = start(path, true);
    const right = start(path, true);
    await Promise.all([message(left, 'ready'), message(right, 'ready')]);
    const leftResult = Promise.race([message(left, 'acquired'), message(left, 'failed')]);
    const rightResult = Promise.race([message(right, 'acquired'), message(right, 'failed')]);

    // When
    await Promise.all([send(left, 'acquire'), send(right, 'acquire')]);
    const results = await Promise.all([leftResult, rightResult]);

    // Then
    expect(results.map((result) => result.status).sort()).toEqual(['acquired', 'failed']);
    expect(results.find((result) => result.status === 'failed')?.code).toBe('held');
    expect((await readdir(dirname(path))).filter((name) => name !== 'bungee.lock')).toEqual([]);
  });

  test('fails closed without deleting malformed, unverifiable, symlink, or non-regular locks', async () => {
    // Given
    const path = await lockPath();
    await mkdir(dirname(path), { recursive: true });
    const validToken = 'A'.repeat(43);
    const invalidRecords = [
      '{',
      `{"token":"${validToken}","pid":99999999}`,
      JSON.stringify({ pid: Number.MAX_SAFE_INTEGER, token: validToken }),
      'x'.repeat(4097),
    ];

    // When / Then
    for (const content of invalidRecords) {
      await writeFile(path, content);
      await expectLockFailure(path, 'invalid');
      expect(await readFile(path, 'utf8')).toBe(content);
      await unlink(path);
    }

    const target = join(dirname(path), 'target');
    await writeFile(target, 'outside');
    await symlink(target, path);
    await expectLockFailure(path, 'invalid');
    expect(await readFile(target, 'utf8')).toBe('outside');
    await unlink(path);
    await mkdir(path);
    await expectLockFailure(path, 'invalid');
    expect((await lstat(path)).isDirectory()).toBeTrue();

    const physicalParent = join(dirname(path), 'physical-parent');
    const linkedParent = join(dirname(path), 'linked-parent');
    await mkdir(physicalParent);
    await symlink(physicalParent, linkedParent);
    await expectLockFailure(join(linkedParent, 'bungee.lock'), 'invalid');
  });

  test('an old handle cannot release a replacement lock and release is idempotent', async () => {
    // Given
    const path = await lockPath();
    const old = await acquireMasterInstanceLock(path);
    await unlink(path);
    const current = await acquireMasterInstanceLock(path);
    const currentText = await readFile(path, 'utf8');

    // When
    await old.release();
    await old.release();

    // Then
    expect(await readFile(path, 'utf8')).toBe(currentText);
    await current.release();
    expect(await readdir(dirname(path))).toEqual([]);
  });

  test('does not treat an extra hard link as authority to release another owner', async () => {
    // Given
    const path = await lockPath();
    const owner = await acquireMasterInstanceLock(path);
    const alias = `${path}.alias`;
    await link(path, alias);

    // When
    await owner.release();

    // Then
    expect(await readFile(alias, 'utf8')).toContain(owner.token);
    await unlink(alias);
  });
});
