import { constants as fsConstants } from 'node:fs';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, parse, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';

export type FileIdentity = Readonly<{ dev: string; ino: string }>;
export type LegacyPidRead =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'valid'; pid: number; identity: FileIdentity }>
  | Readonly<{ kind: 'unsafe' }>
  | Readonly<{ kind: 'unknown' }>;

const MAX_PID_BYTES = 64;
const UNSUPPORTED_DIR_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM', 'EISDIR']);

function identity(stat: { readonly dev: bigint | number; readonly ino: bigint | number }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}
function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function regular(stat: { isFile(): boolean; readonly nlink: number }): boolean {
  return stat.isFile() && stat.nlink === 1;
}

async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new Error('PID mirror path contains a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw error;
      throw error;
    }
  }
}

async function syncDirectory(directory: string, platform: NodeJS.Platform): Promise<void> {
  if (platform === 'win32') return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0));
    await handle.sync();
  } catch (error) {
    if (!UNSUPPORTED_DIR_FSYNC.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); }
      catch (error) { if (!UNSUPPORTED_DIR_FSYNC.has((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  }
}

/** Reads only a single regular PID file; all unsafe/uncertain cases are explicit. */
export async function readLegacyPidFile(path: string): Promise<LegacyPidRead> {
  let listed: Awaited<ReturnType<typeof lstat>>;
  try { listed = await lstat(path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' };
  }
  if (!regular(listed) || listed.isSymbolicLink()) return { kind: 'unsafe' };
  const expected = identity(listed);
  const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!regular(opened) || !sameIdentity(expected, identity(opened))) return { kind: 'unsafe' };
    if (opened.size > MAX_PID_BYTES) return { kind: 'unsafe' };
    const value = (await handle.readFile('utf8')).trim();
    const final = await handle.stat();
    if (!regular(final) || !sameIdentity(expected, identity(final)) || final.size !== opened.size) return { kind: 'unsafe' };
    if (!/^\d+$/.test(value)) return { kind: 'unsafe' };
    const pid = Number(value);
    return Number.isSafeInteger(pid) && pid > 0 ? { kind: 'valid', pid, identity: expected } : { kind: 'unsafe' };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ELOOP' ? { kind: 'unsafe' } : { kind: 'unknown' };
  } finally {
    try { await handle?.close(); } catch { /* best effort */ }
  }
}

export async function deleteLegacyPidFile(path: string, expected: FileIdentity): Promise<boolean> {
  try {
    const current = await lstat(path);
    if (!regular(current) || current.isSymbolicLink() || !sameIdentity(identity(current), expected)) return false;
    await unlink(path);
    return true;
  } catch { return false; }
}

export type LegacyPidMirrorOptions = Readonly<{ platform?: NodeJS.Platform }>;

/** Atomically replaces a legacy mirror without following the existing directory entry. */
export async function writeLegacyPidMirror(path: string, pid: number, options: LegacyPidMirrorOptions = {}): Promise<void> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !isAbsolute(path) || path.includes('\0')) throw new Error('invalid PID mirror target');
  const target = resolve(path);
  const directory = dirname(target);
  await rejectSymlinkComponents(directory);
  const temporary = `${target}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`;
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  try {
    await handle.writeFile(String(pid));
    await handle.chmod(0o600);
    const written = await handle.stat();
    if (!regular(written) || written.nlink !== 1 || written.size !== String(pid).length) throw new Error('PID mirror verification failed');
    await handle.sync();
    await handle.close();
    await rename(temporary, target);
    await syncDirectory(directory, options.platform ?? process.platform);
  } catch (error) {
    try { await handle.close(); } catch { /* best effort */ }
    try { await unlink(temporary); } catch { /* best effort */ }
    throw error;
  }
}
