import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

const MAX_RECORD_BYTES = 4096;
const MAX_PID = 2_147_483_647;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

type LockRecord = {
  readonly pid: number;
  readonly token: string;
};

type ReadResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'record'; readonly record: LockRecord }
  | { readonly kind: 'invalid'; readonly cause?: unknown };

export type MasterInstanceLock = LockRecord & {
  readonly path: string;
  readonly release: () => Promise<void>;
};

export type MasterInstanceLockErrorCode = 'held' | 'invalid' | 'io';

export class MasterInstanceLockError extends Error {
  readonly name = 'MasterInstanceLockError';

  constructor(
    readonly code: MasterInstanceLockErrorCode,
    readonly path: string,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

function errno(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return typeof descriptor?.value === 'string' ? descriptor.value : undefined;
}

function canonicalRecord(record: LockRecord): string {
  return `{"pid":${record.pid},"token":"${record.token}"}`;
}

function parseRecord(text: string): LockRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const pid = Reflect.get(value, 'pid');
  const token = Reflect.get(value, 'token');
  if (!Number.isSafeInteger(pid) || typeof pid !== 'number' || pid <= 0 || pid > MAX_PID) return null;
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) return null;
  const record = { pid, token };
  return Object.keys(value).length === 2 && text === canonicalRecord(record) ? record : null;
}

async function readLock(path: string): Promise<ReadResult> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (errno(error) === 'ENOENT') return { kind: 'missing' };
    if (errno(error) === 'ELOOP') return { kind: 'invalid', cause: error };
    return { kind: 'invalid', cause: error };
  }
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size <= 0 || before.size > MAX_RECORD_BYTES) return { kind: 'invalid' };
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const after = await handle.stat();
    if (bytesRead > MAX_RECORD_BYTES || after.size !== bytesRead || before.ino !== after.ino) {
      return { kind: 'invalid' };
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch (error) {
      return { kind: 'invalid', cause: error };
    }
    const record = parseRecord(text);
    return record === null ? { kind: 'invalid' } : { kind: 'record', record };
  } catch (error) {
    return { kind: 'invalid', cause: error };
  } finally {
    await handle.close();
  }
}

function processIsDead(pid: number, path: string): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (errno(error) === 'ESRCH') return true;
    throw new MasterInstanceLockError('invalid', path, `lock owner PID ${pid} cannot be verified`, error);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (errno(error) !== 'ENOENT') throw error;
  }
}

async function sameRegularFile(left: string, right: string): Promise<boolean> {
  try {
    const [leftStatus, rightStatus] = await Promise.all([lstat(left), lstat(right)]);
    return leftStatus.isFile() && rightStatus.isFile()
      && !leftStatus.isSymbolicLink() && !rightStatus.isSymbolicLink()
      && leftStatus.dev === rightStatus.dev && leftStatus.ino === rightStatus.ino;
  } catch (error) {
    if (errno(error) === 'ENOENT') return false;
    throw error;
  }
}

async function publish(path: string, temporaryPath: string): Promise<boolean> {
  try {
    await link(temporaryPath, path);
    return true;
  } catch (error) {
    if (errno(error) === 'EEXIST') return false;
    throw new MasterInstanceLockError('io', path, 'failed to publish instance lock', error);
  }
}

async function reclaim(path: string, temporaryPath: string, stale: LockRecord): Promise<boolean> {
  const markerPath = `${path}.reclaim-${stale.token}`;
  try {
    await link(path, markerPath);
  } catch (error) {
    if (errno(error) === 'EEXIST' || errno(error) === 'ENOENT') return false;
    throw new MasterInstanceLockError('io', path, 'failed to arbitrate stale lock recovery', error);
  }
  try {
    const current = await readLock(path);
    if (current.kind === 'missing') return false;
    if (current.kind === 'invalid') {
      throw new MasterInstanceLockError('invalid', path, 'instance lock changed during recovery', current.cause);
    }
    if (current.record.pid !== stale.pid || current.record.token !== stale.token) return false;
    if (!(await sameRegularFile(path, markerPath))) {
      throw new MasterInstanceLockError('invalid', path, 'instance lock changed during recovery');
    }
    await unlink(path);
    return await publish(path, temporaryPath);
  } finally {
    await unlinkIfPresent(markerPath);
  }
}

async function releaseOwned(path: string, owner: LockRecord): Promise<void> {
  const current = await readLock(path);
  if (current.kind === 'missing') return;
  if (current.kind === 'invalid') {
    throw new MasterInstanceLockError('invalid', path, 'instance lock is not a verifiable regular file', current.cause);
  }
  if (current.record.pid !== owner.pid || current.record.token !== owner.token) return;
  await unlink(path);
}

export async function acquireMasterInstanceLock(path: string): Promise<MasterInstanceLock> {
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const parentStatus = await lstat(parent);
  if (parentStatus.isSymbolicLink() || !parentStatus.isDirectory()) {
    throw new MasterInstanceLockError('invalid', path, 'lock parent must be a non-symlink directory');
  }

  const owner: LockRecord = { pid: process.pid, token: randomBytes(32).toString('base64url') };
  const temporaryPath = join(parent, `.${basename(path)}.${owner.token}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(canonicalRecord(owner), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;

    let acquired = await publish(path, temporaryPath);
    if (!acquired) {
      const existing = await readLock(path);
      if (existing.kind === 'missing') acquired = await publish(path, temporaryPath);
      else if (existing.kind === 'invalid') {
        throw new MasterInstanceLockError(
          'invalid', path, 'instance lock is not a canonical regular owner record', existing.cause,
        );
      } else if (!processIsDead(existing.record.pid, path)) {
        throw new MasterInstanceLockError('held', path, `instance lock is held by PID ${existing.record.pid}`);
      } else {
        acquired = await reclaim(path, temporaryPath, existing.record);
      }
    }
    if (!acquired) throw new MasterInstanceLockError('held', path, 'instance lock acquisition lost a race');

    let released = false;
    return Object.freeze({
      ...owner,
      path,
      async release() {
        if (released) return;
        await releaseOwned(path, owner);
        released = true;
      },
    });
  } catch (error) {
    if (error instanceof MasterInstanceLockError) throw error;
    throw new MasterInstanceLockError('io', path, 'failed to acquire instance lock', error);
  } finally {
    if (handle !== null) await handle.close();
    await unlinkIfPresent(temporaryPath);
  }
}
