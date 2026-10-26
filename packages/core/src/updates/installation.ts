import { randomUUID } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import type { UpdateOperation } from '@jeffusion/bungee-types';
import { getBinaryName } from './names';
import { parseVersion, UpdateError } from './release';

export const ACTIVE_UPDATE_PHASES = new Set<UpdateOperation['phase']>(['downloading', 'verifying', 'awaiting_confirmation', 'stopping', 'restarting']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function installationRoot(path: string): string {
  if (!isAbsolute(path)) throw new UpdateError('install_unavailable');
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (process.platform !== 'win32'
    && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))) throw new UpdateError('install_unavailable');
  return realpathSync(path);
}

export function readPrivateText(path: string, limit = 16_384): string {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit
    || (process.platform !== 'win32' && (stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0))) throw new UpdateError('install_unavailable');
  return readFileSync(path, 'utf8');
}

export function atomicWrite(path: string, value: string): void {
  if (existsSync(path)) readPrivateText(path);
  const temporary = `${path}.${randomUUID()}`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); }
  finally { closeSync(fd); }
  try { renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
  if (process.platform !== 'win32') {
    const directory = openSync(dirname(path), 'r');
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}

export function selectedVersion(root: string): string | null {
  const path = join(root, 'version.txt');
  if (!existsSync(path)) return null;
  return parseVersion(readPrivateText(path, 128).trim());
}

export function installedExecutable(root: string, version = selectedVersion(root)): string {
  if (version === null) throw new UpdateError('binary_not_installed');
  const path = join(root, 'bin', parseVersion(version), getBinaryName());
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()
    || !lstatSync(join(root, 'bin', version, 'plugins')).isDirectory()) throw new UpdateError('install_unavailable');
  accessSync(path, constants.X_OK);
  return realpathSync(path);
}

export function assertNoUpdate(root: string): void {
  if (existsSync(join(root, 'update.lock'))) throw new UpdateError('update_busy', 409);
}

export function requestUpdateStop(root: string): void {
  if (!existsSync(join(root, 'update.lock'))) return;
  const store = new UpdateStore(root), owner = store.owner();
  if (owner) atomicWrite(join(store.root, 'update-stop.json'), JSON.stringify({ token: owner.token }));
}

export function assertUpdateStart(root: string, token?: string): void {
  if (!existsSync(join(root, 'update.lock'))) return;
  const store = new UpdateStore(root), owner = store.owner();
  if (!owner || owner.token !== token || owner.pid !== process.pid || store.stopRequested(owner.token)) throw new UpdateError('update_busy', 409);
}

export function recordUpdateStartupFailure(root: string | undefined, token: string | undefined): void {
  if (!root || !token) return;
  const store = new UpdateStore(root), owner = store.owner(), operation = store.read();
  if (owner?.token !== token || owner.pid !== process.pid || operation?.phase !== 'restarting') return;
  store.write({ ...operation, phase: store.stopRequested(token) ? 'cancelled' : 'failed',
    error: store.stopRequested(token) ? 'update_cancelled' : 'startup_failed', updated_at: Date.now() });
  store.release(token);
}

export class UpdateStore {
  readonly root: string;
  private readonly directory: string;
  constructor(root: string) {
    this.root = installationRoot(root);
    this.directory = join(this.root, 'updates');
    installationRoot(this.directory);
    installationRoot(join(this.root, 'bin'));
  }
  read(id?: string): UpdateOperation | null {
    if (id !== undefined && !UUID.test(id)) throw new UpdateError('invalid_request', 400);
    const path = id ? join(this.directory, `${id}.json`) : join(this.root, 'update.json');
    if (!existsSync(path)) return null;
    const op = JSON.parse(readPrivateText(path)) as UpdateOperation;
    if (!op || !UUID.test(op.id) || (id !== undefined && op.id !== id)
      || !['downloading','verifying','awaiting_confirmation','stopping','restarting','succeeded','failed','cancelled'].includes(op.phase)
      || !Number.isSafeInteger(op.started_at) || !Number.isSafeInteger(op.updated_at)
      || (op.error !== null && (typeof op.error !== 'string' || !/^[a-z_]+$/.test(op.error)))) throw new UpdateError('install_unavailable');
    parseVersion(op.source_version); parseVersion(op.target_version);
    return op;
  }
  write(operation: UpdateOperation): void {
    const text = JSON.stringify(operation);
    atomicWrite(join(this.directory, `${operation.id}.json`), text);
    atomicWrite(join(this.root, 'update.json'), text);
  }
  acquire(token: string): void {
    const fd = openSync(join(this.root, 'update.lock'), 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); fsyncSync(fd); }
    finally { closeSync(fd); }
  }
  owner(): {pid: number; token: string} | null {
    const path = join(this.root, 'update.lock');
    if (!existsSync(path)) return null;
    const owner = JSON.parse(readPrivateText(path));
    if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !UUID.test(owner.token)) throw new UpdateError('install_unavailable');
    return owner;
  }
  release(token: string): void {
    const owner = this.owner();
    if (owner?.token !== token || owner.pid !== process.pid) throw new UpdateError('update_owner_changed', 409);
    unlinkSync(join(this.root, 'update.lock'));
  }
  select(version: string): void { atomicWrite(join(this.root, 'version.txt'), `${parseVersion(version)}\n`); }
  stopRequested(token: string): boolean {
    const path = join(this.root, 'update-stop.json');
    return existsSync(path) && JSON.parse(readPrivateText(path)).token === token;
  }
}
