import { dlopen, ptr, toArrayBuffer, type Pointer } from 'bun:ffi';
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statfsSync, writeFileSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { canonicalJson } from '../config-storage/content-hash';
import { isLowercaseUuid } from '../config-storage/validation';

export const PROCESS_LIFETIME_GUARD_ENV = 'BUNGEE_PROCESS_LIFETIME_GUARD';
export const PROCESS_LIFETIME_GUARD_DOMAIN = 'bungee-local-flock';
export type ProcessLifetimeGuardFacts = Readonly<{
  schema: 'bungee-process-lifetime-guard-v1';
  identity: string;
  process_instance_id: string;
  path: string;
  device: string;
  inode: string;
  host_boot_id: string;
  domain: typeof PROCESS_LIFETIME_GUARD_DOMAIN;
}>;
export type HeldProcessLifetimeGuardFacts = ProcessLifetimeGuardFacts & Readonly<{ held: true }>;
export type ProcessLifetimeRetirementFence = { readonly facts: ProcessLifetimeGuardFacts; isCurrent(): boolean; close(): void };
export type ProcessLifetimeGuardProbe =
  | { readonly kind: 'live' }
  | { readonly kind: 'confirmed'; readonly fence: ProcessLifetimeRetirementFence }
  | { readonly kind: 'unknown'; readonly reason: 'missing' | 'replaced' | 'domain' | 'filesystem' | 'io' | 'malformed' };

type Native = { flock(fd: number, operation: number): number; fcntl(fd: number, operation: number): number;
  ioctl(fd: number, operation: number): number; errno(): number; inheritedLock?(fd: number): boolean; filesystem?(path: string): boolean };
// Keep the native library alive for as long as its cached function pointers.
let native: (Native & { readonly library: unknown }) | undefined;
function functions(): Native {
  if (native !== undefined) return native;
  if (process.platform !== 'linux' && process.platform !== 'darwin') throw new Error('process lifetime guard is unsupported in this domain');
  const paths = process.platform === 'darwin' ? ['/usr/lib/libSystem.B.dylib']
    : ['libc.so.6', 'libc.so', `/lib/libc.musl-${process.arch === 'x64' ? 'x86_64' : 'aarch64'}.so.1`];
  for (const path of paths) {
    try {
      const library = dlopen(path, {
        flock: { args: ['i32', 'i32'], returns: 'i32' },
        // These operations have no variadic payload. In particular, Apple arm64
        // must not receive a fcntl third argument through a fixed-argument FFI.
        fcntl: { args: ['i32', 'i32'], returns: 'i32' },
        ioctl: { args: ['i32', 'u64'], returns: 'i32' },
        [process.platform === 'darwin' ? '__error' : '__errno_location']: { args: [], returns: 'ptr' },
        ...(process.platform === 'darwin' ? { statfs64: { args: ['ptr', 'ptr'] as const, returns: 'i32' as const },
          proc_pidfdinfo: { args: ['i32', 'i32', 'i32', 'ptr', 'i32'] as const, returns: 'i32' as const } } : {}),
      });
      const symbols = library.symbols as unknown as Record<string, (...args: number[]) => number>;
      native = { library, flock: symbols.flock!, fcntl: symbols.fcntl!, ioctl: symbols.ioctl!, errno: () => {
        const address = symbols[process.platform === 'darwin' ? '__error' : '__errno_location']!();
        return new Int32Array(toArrayBuffer(address as Pointer, 0, 4))[0]!;
      }, ...(process.platform === 'darwin' ? { inheritedLock(fd: number) {
        // XNU exposes the actual fileglob flags in proc_fileinfo. FWASLOCKED
        // belongs to the shared open description and is absent on a reopened FD.
        // No child path unlocks or acquires this lock; retirement marks the file
        // irreversibly before any retirement fence can be released.
        const data = Buffer.alloc(4_096);
        return symbols.proc_pidfdinfo!(process.pid, fd, 1, ptr(data), data.length) >= 24
          && (data.readUInt32LE(0) & 0x00004000) !== 0;
      }, filesystem(path: string) {
        // Apple statfs64's f_fstypename starts at byte 72 in the 64-bit ABI;
        // f_type is a dynamically assigned VFS number, not a stable FS magic.
        const pathname = Buffer.from(`${path}\0`); const data = Buffer.alloc(2_168);
        if (symbols.statfs64!(ptr(pathname), ptr(data)) !== 0) return false;
        const type = data.subarray(72, 88).toString('utf8').split('\0')[0];
        return type === 'apfs' || type === 'hfs';
      } } : {}) };
      return native;
    } catch { /* try the next system C library */ }
  }
  throw new Error('process lifetime guard native library is unavailable');
}

export function processLifetimeHostBootId(): string {
  if (process.platform === 'linux') {
    const boot = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    if (!isLowercaseUuid(boot)) throw new Error('process lifetime guard host boot identity is unavailable');
    return `linux:${boot}`;
  }
  if (process.platform === 'darwin') {
    const boot = execFileSync('/usr/sbin/sysctl', ['-n', 'kern.boottime'], { encoding: 'utf8', timeout: 2_000 }).trim();
    const match = /^\{\s*sec\s*=\s*(\d+)\s*,\s*usec\s*=\s*(\d+)\s*\}/.exec(boot);
    if (match === null) throw new Error('process lifetime guard host boot identity is unavailable');
    return `darwin:${BigInt(match[1]!).toString()}:${BigInt(match[2]!).toString()}`;
  }
  throw new Error('process lifetime guard has no cross-domain proof on this platform');
}

export function parseProcessLifetimeGuardFacts(value: unknown): ProcessLifetimeGuardFacts {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('process lifetime guard facts are malformed');
  const facts = value as Record<string, unknown>;
  const keys = ['schema', 'identity', 'process_instance_id', 'path', 'device', 'inode', 'host_boot_id', 'domain'];
  if (Object.keys(facts).length !== keys.length || keys.some(key => !Object.hasOwn(facts, key))
    || facts.schema !== 'bungee-process-lifetime-guard-v1' || facts.domain !== PROCESS_LIFETIME_GUARD_DOMAIN
    || typeof facts.identity !== 'string' || !isLowercaseUuid(facts.identity)
    || typeof facts.process_instance_id !== 'string' || !isLowercaseUuid(facts.process_instance_id)
    || typeof facts.path !== 'string' || facts.path !== resolve(facts.path)
    || typeof facts.device !== 'string' || !/^\d+$/.test(facts.device)
    || typeof facts.inode !== 'string' || !/^[1-9]\d*$/.test(facts.inode)
    || typeof facts.host_boot_id !== 'string' || !/^(linux:[0-9a-f-]{36}|darwin:\d+:\d+)$/.test(facts.host_boot_id)) {
    throw new Error('process lifetime guard facts are malformed');
  }
  return Object.freeze({ ...facts }) as ProcessLifetimeGuardFacts;
}

export function parseHeldProcessLifetimeGuardFacts(value: unknown): HeldProcessLifetimeGuardFacts {
  if (typeof value !== 'object' || value === null || (value as { held?: unknown }).held !== true) throw new Error('process lifetime guard held acknowledgement is malformed');
  const { held: _held, ...body } = value as Record<string, unknown>;
  return Object.freeze({ ...parseProcessLifetimeGuardFacts(body), held: true });
}

function trustedFilesystem(path: string): boolean {
  if (process.platform === 'darwin') return functions().filesystem?.(path) === true;
  // Local Linux ext, XFS, Btrfs, tmpfs and overlayfs. Network and unknown
  // filesystems never produce proof, even if flock happens to succeed.
  return process.platform === 'linux' && [0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630].includes(Number(statfsSync(path).type));
}
const GUARD_ARMED = 'armed  ';
const GUARD_RETIRED = 'retired';
function readGuardFile(fd: number): { facts: ProcessLifetimeGuardFacts; retired: boolean } {
  const buffer = Buffer.alloc(4_096);
  const length = readSync(fd, buffer, 0, buffer.length, 0);
  if (length === buffer.length) throw new Error('process lifetime guard file exceeds limit');
  const content = buffer.subarray(0, length).toString('utf8');
  const state = content.slice(0, 7);
  if ((state !== GUARD_ARMED && state !== GUARD_RETIRED) || content[7] !== '\n') throw new Error('process lifetime guard file state is invalid');
  return { facts: parseProcessLifetimeGuardFacts(JSON.parse(content.slice(8))), retired: state === GUARD_RETIRED };
}
function readFacts(fd: number): ProcessLifetimeGuardFacts {
  return readGuardFile(fd).facts;
}
function descriptorMatches(fd: number, facts: ProcessLifetimeGuardFacts): boolean {
  const stat = fstatSync(fd, { bigint: true });
  return stat.isFile() && stat.nlink === 1n && stat.dev.toString() === facts.device && stat.ino.toString() === facts.inode;
}
function closeOnExec(fd: number): void {
  const api = functions();
  // FIOCLEX is a no-payload ioctl; F_GETFD uses only fcntl's two fixed prefix
  // arguments. Both calls therefore have the same ABI on Apple arm64 and Linux.
  const operation = process.platform === 'darwin' ? 0x20006601 : 0x5451;
  if (api.ioctl(fd, operation) !== 0) throw new Error('process lifetime guard close-on-exec failed');
  const flags = api.fcntl(fd, 1);
  if (flags < 0 || (flags & 1) !== 1) throw new Error('process lifetime guard close-on-exec failed');
}
function onceClose(fd: number): () => void {
  let closed = false;
  return () => { if (!closed) { closed = true; closeSync(fd); } };
}

/** Parent owns this raw native descriptor until the intended child's signed held ACK. */
export function armProcessLifetimeGuard(options: { directory: string; processInstanceId: string }): {
  readonly fd: number; readonly facts: ProcessLifetimeGuardFacts;
  closeAfterHeldAck(held: HeldProcessLifetimeGuardFacts): void;
  closeAfterChildExit(): void;
} {
  if (!isLowercaseUuid(options.processInstanceId)) throw new Error('process lifetime guard process identity is invalid');
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  if (!trustedFilesystem(options.directory)) throw new Error('process lifetime guard requires a trusted local filesystem');
  const identity = randomUUID();
  const path = resolve(join(options.directory, `${identity}.guard`));
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  const close = onceClose(fd);
  try {
    closeOnExec(fd);
    if (functions().flock(fd, 2 | 4) !== 0) throw new Error('process lifetime guard could not be armed');
    const stat = fstatSync(fd, { bigint: true });
    const facts = parseProcessLifetimeGuardFacts({ schema: 'bungee-process-lifetime-guard-v1', identity,
      process_instance_id: options.processInstanceId, path, device: stat.dev.toString(), inode: stat.ino.toString(),
      host_boot_id: processLifetimeHostBootId(), domain: PROCESS_LIFETIME_GUARD_DOMAIN });
    writeFileSync(fd, `${GUARD_ARMED}\n${JSON.stringify(facts)}`); fsyncSync(fd);
    const directoryFd = openSync(options.directory, constants.O_RDONLY);
    try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
    return { fd, facts,
      closeAfterHeldAck(held) {
        const { held: _held, ...body } = parseHeldProcessLifetimeGuardFacts(held);
        if (canonicalJson(body) !== canonicalJson(facts)) throw new Error('process lifetime guard ACK identity mismatch');
        close();
      },
      closeAfterChildExit: close,
    };
  } catch (error) { close(); throw error; }
}

// Raw FDs are deliberately retained here, outside FileHandle/GC ownership. There is no
// ordinary shutdown close: the operating system releases the child's lock on exit.
const inheritedDescriptors = new Map<string, number>();
/** A directly launched master owns its guard without an FD handoff. It is never closed by ordinary cleanup. */
export function holdCurrentProcessLifetimeGuard(directory: string, processInstanceId: string): HeldProcessLifetimeGuardFacts {
  const armed = armProcessLifetimeGuard({directory,processInstanceId});
  inheritedDescriptors.set(armed.facts.identity,armed.fd);
  return parseHeldProcessLifetimeGuardFacts({...armed.facts,held:true});
}
export function holdInheritedProcessLifetimeGuard(environment: Readonly<NodeJS.ProcessEnv>, processInstanceId: string): HeldProcessLifetimeGuardFacts | null {
  const raw = environment[PROCESS_LIFETIME_GUARD_ENV];
  if (raw === undefined) return null;
  const facts = parseProcessLifetimeGuardFacts(JSON.parse(raw));
  if (facts.process_instance_id !== processInstanceId || facts.host_boot_id !== processLifetimeHostBootId()
    || !trustedFilesystem(facts.path) || !descriptorMatches(3, facts)) throw new Error('inherited process lifetime guard identity mismatch');
  const stored = readGuardFile(3);
  if (canonicalJson(stored.facts) !== canonicalJson(facts)) throw new Error('inherited process lifetime guard file mismatch');
  if (stored.retired) throw new Error('inherited process lifetime guard identity is retired');
  closeOnExec(3);
  // Never flock here: success could mean acquiring an already released lock.
  // Linux reports locks attached to this exact open description in fdinfo.
  const inherited = process.platform === 'linux'
    ? /^lock:\s+\d+: FLOCK\s+ADVISORY\s+WRITE\s+\S+\s+\S+\s+0\s+EOF\s*$/m.test(readFileSync('/proc/self/fdinfo/3', 'utf8'))
    : functions().inheritedLock?.(3) === true;
  if (!inherited) throw new Error('inherited process lifetime guard is not held');
  inheritedDescriptors.set(facts.identity, 3);
  return Object.freeze({ ...facts, held: true });
}

/** Existing-only probe. Confirmed keeps the lock until the durable irreversible fence. */
export function probeExistingProcessLifetimeGuard(value: unknown): ProcessLifetimeGuardProbe {
  let facts: ProcessLifetimeGuardFacts;
  try { facts = parseProcessLifetimeGuardFacts(value); }
  catch { return { kind: 'unknown', reason: 'malformed' }; }
  let fd: number | undefined;
  try {
    if (facts.host_boot_id !== processLifetimeHostBootId()) return { kind: 'unknown', reason: 'domain' };
    fd = openSync(facts.path, constants.O_RDWR | constants.O_NOFOLLOW);
    closeOnExec(fd);
    // Classify a missing file before Darwin's filesystem probe returns false.
    if (!trustedFilesystem(facts.path)) return { kind: 'unknown', reason: 'filesystem' };
    if (!descriptorMatches(fd, facts)) return { kind: 'unknown', reason: 'replaced' };
    const stored = readFacts(fd);
    if (canonicalJson(stored) !== canonicalJson(facts)) return { kind: 'unknown', reason: 'replaced' };
    const api = functions();
    if (api.flock(fd, 2 | 4) !== 0) return api.errno() === (process.platform === 'darwin' ? 35 : 11)
      ? { kind: 'live' } : { kind: 'unknown', reason: 'io' };
    // Reopening and fstat catches replacement during the probe; neither absent files
    // nor a new inode at the same path prove the original process exited.
    const check = openSync(facts.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (!descriptorMatches(check, facts)) return { kind: 'unknown', reason: 'replaced' }; }
    finally { closeSync(check); }
    // A free original lock is an irreversible retirement point. Preserve its
    // inode and signed facts, but forbid any later child ACK for this identity.
    // A torn marker is invalid and yields unknown, never a resurrected owner.
    if (!readGuardFile(fd).retired) {
      const marker = Buffer.from(GUARD_RETIRED);
      if (writeSync(fd, marker, 0, marker.length, 0) !== marker.length) throw new Error('process lifetime guard retirement marker write failed');
      fsyncSync(fd);
    }
    const heldFd = fd;
    const fence: ProcessLifetimeRetirementFence = { facts, close: onceClose(fd), isCurrent() {
      let checkFd: number | undefined;
      try {
        if (facts.host_boot_id !== processLifetimeHostBootId() || !descriptorMatches(heldFd, facts)) return false;
        checkFd = openSync(facts.path, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stored = readGuardFile(checkFd);
        return descriptorMatches(checkFd, facts) && stored.retired && canonicalJson(stored.facts) === canonicalJson(facts);
      } catch { return false; }
      finally { if (checkFd !== undefined) closeSync(checkFd); }
    } };
    fd = undefined;
    return { kind: 'confirmed', fence };
  } catch (error) {
    return { kind: 'unknown', reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'io' };
  } finally { if (fd !== undefined) closeSync(fd); }
}

export type ProcessLifetimeHeldAck = {
  readonly boot_nonce: string;
  readonly guard: HeldProcessLifetimeGuardFacts;
  readonly mac: string;
};

export function writeProcessLifetimeHeldAck(path: string, guard: HeldProcessLifetimeGuardFacts, bootNonce: string, key: Readonly<Uint8Array>): void {
  if (!isLowercaseUuid(bootNonce)) throw new Error('process lifetime guard ACK boot identity is invalid');
  const body = { boot_nonce: bootNonce, guard: parseHeldProcessLifetimeGuardFacts(guard) };
  const ack: ProcessLifetimeHeldAck = { ...body, mac: createHmac('sha256', key as Uint8Array).update(canonicalJson(body)).digest('hex') };
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, JSON.stringify(ack)); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(temporary, path);
  const directoryFd = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
}

export function parseProcessLifetimeHeldAck(value: unknown, key: Readonly<Uint8Array>): ProcessLifetimeHeldAck {
  if (typeof value !== 'object' || value === null || Object.keys(value).length !== 3) throw new Error('process lifetime guard ACK is malformed');
  const input = value as Record<string, unknown>;
  if (typeof input.boot_nonce !== 'string' || !isLowercaseUuid(input.boot_nonce)
    || typeof input.mac !== 'string' || !/^[0-9a-f]{64}$/.test(input.mac)) throw new Error('process lifetime guard ACK is malformed');
  const body = { boot_nonce: input.boot_nonce, guard: parseHeldProcessLifetimeGuardFacts(input.guard) };
  const mac = createHmac('sha256', key as Uint8Array).update(canonicalJson(body)).digest('hex');
  if (!timingSafeEqual(Buffer.from(mac, 'hex'), Buffer.from(input.mac, 'hex'))) throw new Error('process lifetime guard ACK signature is invalid');
  return Object.freeze({ ...body, mac: input.mac });
}
