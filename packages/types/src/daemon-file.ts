import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { promisify } from 'node:util';
import { dirname, isAbsolute, join, normalize, parse, relative, resolve, win32 } from 'node:path';
import type { DaemonMetadataState, DaemonMetadataV1 } from './daemon-control.js';
import { decodeDaemonMetadataV1, encodeDaemonMetadataV1 } from './daemon-control.js';

const execFileAsync = promisify(execFile);
const MAX_BYTES = 4 * 1024;
const METADATA_FILENAME = 'daemon.json';
const WINDOWS_SYSTEM = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS = 'S-1-5-32-544';
const WINDOWS_FULL_CONTROL = 2_032_127;
const WINDOWS_CONTAINER_INHERIT = 1;
const WINDOWS_OBJECT_INHERIT = 2;
const WINDOWS_ACL_EXEC_OPTIONS = {
  windowsHide: true,
  timeout: 10_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 64 * 1024,
};
const SID = /^S-(?:\d+)(?:-\d+)+$/;

export type DaemonFileErrorCode = 'race' | 'path' | 'symlink' | 'containment' | 'directory' | 'owner' | 'permissions'
  | 'file' | 'limit' | 'invalid' | 'acl' | 'state' | 'secret' | 'transition';

export class DaemonFileError extends Error {
  readonly name = 'DaemonFileError';
  constructor(readonly code: DaemonFileErrorCode, message: string = code, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
  }
}

export type WindowsAclEntry = {
  readonly sid: string;
  readonly access: 'allow' | 'deny';
  readonly rights: number;
  readonly inheritance: number;
  readonly propagation: number;
  readonly inherited: boolean;
};

export type WindowsAclSnapshot = {
  readonly currentSid: string;
  readonly entries: readonly WindowsAclEntry[];
};

export type WindowsAclAdapter = {
  readonly read: (path: string) => Promise<WindowsAclSnapshot>;
  readonly set: (path: string, currentSid: string, kind?: 'directory' | 'file') => Promise<void>;
};

export type DaemonFileOptions = {
  /** The trusted, canonical runtime root. The only accepted target is root/daemon.json. */
  readonly runtimeDirectory: string;
  /** Test-only platform injection; production leaves this unset. */
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsAclAdapter;
  /** Deterministic race injection for the metadata primitive tests. */
  readonly testHooks?: {
    readonly afterOpen?: (target: string) => void | Promise<void>;
    readonly afterInitialStat?: (target: string) => void | Promise<void>;
  };
};

type FileIdentity = { readonly dev: string; readonly ino: string };
type ReadEvidence = {
  readonly target: string;
  readonly root: string;
  readonly bytes: Uint8Array;
  readonly identity: FileIdentity;
  readonly metadata: DaemonMetadataV1;
};

const POSIX_UNSUPPORTED_FSYNC = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS']);
const WINDOWS_UNSUPPORTED_FSYNC = new Set([...POSIX_UNSUPPORTED_FSYNC, 'EPERM', 'EISDIR']);

function fail(code: DaemonFileErrorCode, message: string, cause?: unknown): never {
  throw new DaemonFileError(code, message, cause);
}
function currentPlatform(options: DaemonFileOptions): NodeJS.Platform { return options.platform ?? process.platform; }

function comparePath(value: string, platform: NodeJS.Platform): string {
  const normalized = (platform === 'win32' ? win32.normalize(value) : normalize(value)).split('\\').join('/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contained(parent: string, child: string, platform: NodeJS.Platform): boolean {
  const root = comparePath(parent, platform);
  const target = comparePath(child, platform);
  return target !== root && target.startsWith(`${root}/`);
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function canonicalSid(value: string): boolean {
  return SID.test(value) && value.slice(2).split('-').every((part) => part === '0' || !part.startsWith('0'));
}

function identity(stat: { readonly dev: bigint | number; readonly ino: bigint | number }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function mode(stat: { readonly mode: number }): number { return stat.mode & 0o777; }

async function rejectSymlinkComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) fail('symlink', 'daemon runtime path contains a symlink');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
  }
}

async function canonicalProfile(options: DaemonFileOptions): Promise<string> {
  const profile = process.env.USERPROFILE;
  if (profile === undefined || !isAbsolute(profile)) fail('containment', 'USERPROFILE is unavailable');
  try { return await realpath(profile); }
  catch { fail('containment', 'USERPROFILE cannot be canonicalized'); }
}

async function secureRuntimeDirectory(options: DaemonFileOptions, allowCreate: boolean): Promise<string> {
  const requested = options.runtimeDirectory;
  if (!isAbsolute(requested) || requested.includes('\0')) fail('path', 'runtime directory must be absolute and NUL-free');
  await rejectSymlinkComponents(requested);
  let before;
  try { before = await lstat(requested); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || !allowCreate) throw error;
    await mkdir(requested, { recursive: true, mode: 0o700 });
    before = await lstat(requested);
  }
  if (!before.isDirectory() || before.isSymbolicLink()) fail('directory', 'runtime directory is not a real directory');
  const root = await realpath(requested);
  const platform = currentPlatform(options);
  if (platform === 'win32') {
    const profile = await canonicalProfile(options);
    if (!contained(profile, root, platform)) fail('containment', 'runtime directory must be a strict child of USERPROFILE');
    // Profile containment is deliberately before any ACL adapter call.
    await ensureWindowsAcl(root, options.windowsAcl ?? defaultWindowsAclAdapter(), 'directory');
  } else {
    if (typeof process.geteuid === 'function' && before.uid !== process.geteuid()) fail('owner', 'runtime directory owner is invalid');
    if (mode(before) !== 0o700) await chmod(requested, 0o700);
    const after = await lstat(requested);
    if (!after.isDirectory() || after.uid !== before.uid || mode(after) !== 0o700) fail('permissions', 'runtime directory permissions are not 0700');
  }
  return root;
}

async function secureTarget(
  targetPath: string, options: DaemonFileOptions, mustExist: boolean,
): Promise<{ readonly root: string; readonly target: string; readonly initial?: ReturnType<typeof identity> }> {
  const platform = currentPlatform(options);
  if (!isAbsolute(targetPath) || targetPath.includes('\0')) fail('path', 'metadata target must be absolute and NUL-free');
  const requestedTarget = resolve(targetPath);
  const requestedExpected = resolve(options.runtimeDirectory, METADATA_FILENAME);
  if (comparePath(requestedTarget, platform) !== comparePath(requestedExpected, platform)) {
    // Do this before touching the trusted root so an untrusted path cannot cause ACL work.
    fail('containment', 'metadata target is not the fixed runtime target');
  }
  const root = await secureRuntimeDirectory(options, !mustExist);
  const target = resolve(targetPath);
  const expected = resolve(root, METADATA_FILENAME);
  if (comparePath(target, platform) !== comparePath(expected, platform)) {
    fail('containment', 'metadata target is not the fixed runtime target');
  }
  await rejectSymlinkComponents(targetPath);
  try {
    const item = await lstat(target);
    if (item.isSymbolicLink()) fail('symlink', 'metadata file must not be a symlink');
    if (!item.isFile() || item.nlink !== 1) fail('file', 'metadata file must be a single regular file');
    if (platform !== 'win32' && typeof process.geteuid === 'function' && item.uid !== process.geteuid()) fail('owner', 'metadata owner is invalid');
    if (platform === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file');
    const canonical = await realpath(target);
    if (!contained(root, canonical, platform)) fail('containment', 'metadata file escaped the runtime root');
    return { root, target, initial: identity(item) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mustExist) throw error;
    return { root, target };
  }
}

function assertDescriptor(item: { isFile(): boolean; readonly nlink: number; readonly size: number; readonly uid: number; readonly mode: number; readonly dev: number | bigint; readonly ino: number | bigint }, expected: FileIdentity | undefined, platform: NodeJS.Platform): void {
  if (!item.isFile() || item.nlink > 1) fail('file', 'opened metadata descriptor is not a single regular file');
  if (item.nlink === 0) fail('race', 'opened metadata descriptor was detached by rename');
  if (expected !== undefined && !sameIdentity(identity(item), expected)) fail('race', 'metadata file identity changed');
  if (platform !== 'win32' && typeof process.geteuid === 'function' && item.uid !== process.geteuid()) fail('owner', 'metadata owner changed');
}

async function verifyLstat(target: string, expected: FileIdentity, platform: NodeJS.Platform, expectedMode?: number): Promise<ReturnType<typeof identity>> {
  const item = await lstat(target);
  if (!item.isFile() || item.isSymbolicLink() || item.nlink > 1) fail('file', 'metadata file is not a single regular file');
  if (item.nlink === 0 || !sameIdentity(identity(item), expected)) fail('race', 'metadata file changed');
  if (platform !== 'win32' && typeof process.geteuid === 'function' && item.uid !== process.geteuid()) fail('owner', 'metadata owner changed');
  if (platform !== 'win32' && expectedMode !== undefined && mode(item) !== expectedMode) fail('permissions', 'metadata file permissions are not exact');
  return identity(item);
}

async function removeOwnedFile(path: string, expected: FileIdentity): Promise<void> {
  try {
    const item = await lstat(path);
    if (!item.isFile() || item.isSymbolicLink() || item.nlink !== 1 || !sameIdentity(identity(item), expected)) return;
    await unlink(path);
  } catch { /* fail closed: never unlink an unproven replacement */ }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index]);
}

async function readEvidence(path: string, options: DaemonFileOptions): Promise<ReadEvidence> {
  const safe = await secureTarget(path, options, true);
  const platform = currentPlatform(options);
  if (safe.initial === undefined) fail('file', 'metadata file disappeared');
  const noFollow = platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
  const handle = await open(safe.target, fsConstants.O_RDONLY | noFollow);
  try {
    await options.testHooks?.afterOpen?.(safe.target);
    const opened = await handle.stat();
    assertDescriptor(opened, safe.initial, platform);
    if (opened.size > MAX_BYTES) fail('limit', 'daemon metadata file exceeds 4 KiB');
    if (platform !== 'win32' && mode(opened) !== 0o600) await handle.chmod(0o600);
    const secured = await handle.stat();
    assertDescriptor(secured, safe.initial, platform);
    if (platform !== 'win32' && mode(secured) !== 0o600) fail('permissions', 'metadata file permissions are not exact');
    await verifyLstat(safe.target, safe.initial, platform, 0o600);
    await options.testHooks?.afterInitialStat?.(safe.target);

    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const chunk = new Uint8Array(MAX_BYTES + 1);
      const result = await handle.read(chunk, 0, chunk.byteLength, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
      if (total > MAX_BYTES) fail('race', 'daemon metadata file grew while reading');
      chunks.push(chunk.slice(0, result.bytesRead));
    }
    const finalStat = await handle.stat();
    assertDescriptor(finalStat, safe.initial, platform);
    if (finalStat.size !== total || finalStat.size !== opened.size) fail('race', 'metadata file size changed while reading');
    await verifyLstat(safe.target, safe.initial, platform, 0o600);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const metadata = decodeDaemonMetadataV1(bytes);
    const canonical = new TextEncoder().encode(encodeDaemonMetadataV1(metadata));
    if (!bytesEqual(bytes, canonical)) fail('invalid', 'metadata bytes are not canonical');
    return { target: safe.target, root: safe.root, bytes: canonical, identity: safe.initial, metadata };
  } finally { await handle.close(); }
}

async function ensureWindowsAcl(path: string, adapter: WindowsAclAdapter, kind: 'directory' | 'file'): Promise<void> {
  let snapshot = await adapter.read(path);
  if (!windowsAclSecure(snapshot, kind)) await adapter.set(path, snapshot.currentSid, kind);
  snapshot = await adapter.read(path);
  if (!windowsAclSecure(snapshot, kind)) fail('acl', 'Windows ACL is not restricted to the approved SIDs');
}

function windowsAclSecure(snapshot: WindowsAclSnapshot, kind: 'directory' | 'file'): boolean {
  if (!canonicalSid(snapshot.currentSid)) return false;
  const expected = new Set([snapshot.currentSid, WINDOWS_SYSTEM, WINDOWS_ADMINISTRATORS]);
  const inheritance = kind === 'directory' ? WINDOWS_CONTAINER_INHERIT | WINDOWS_OBJECT_INHERIT : 0;
  if (snapshot.entries.length !== expected.size) return false;
  for (const entry of snapshot.entries) {
    if (!canonicalSid(entry.sid) || entry.access !== 'allow' || entry.rights !== WINDOWS_FULL_CONTROL
      || entry.inheritance !== inheritance || entry.propagation !== 0 || entry.inherited || !expected.delete(entry.sid)) return false;
  }
  return expected.size === 0;
}

function encodedPowerShell(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }

function redactPath(value: string): RegExp {
  const normalized = value.replace(/\\/gu, '/');
  return new RegExp(normalized.split('/').map(escapeRegExp).join('[/\\\\]+'), 'giu');
}

function boundedAclStderr(value: string, path: string, sid?: string): string {
  const secrets = [path, sid, process.env.USERPROFILE, process.env.HOME, homedir(),
    ...Object.values(process.env)]
    .filter((item): item is string => item !== undefined && item.length > 0)
    .sort((left, right) => right.length - left.length);
  let sanitized = value;
  for (const secret of secrets) {
    if (secret.includes('/') || secret.includes('\\')) sanitized = sanitized.replace(redactPath(secret), '[REDACTED]');
    else sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'giu'), '[REDACTED]');
  }
  sanitized = sanitized
    .replace(/S-(?:\d+)(?:-\d+)+/giu, '[REDACTED]')
    .replace(/(?:^|\s)-EncodedCommand(?:\s+\S+)?/giu, ' [REDACTED]')
    .replace(/(?:secret|token|password|api[-_]?key)\s*[:=]\s*[^\s,;]+/giu, '[REDACTED]')
    .replace(/\benvironment\b/giu, '[REDACTED]')
    .replace(/\$(?:env:)?[A-Z_][A-Z0-9_]*/giu, '[REDACTED]')
    .replace(/\b(?:BUNGEE|USERPROFILE|HOME|PATH|TEMP|TMP|ENV)(?:_[A-Z0-9_]*)?\b/giu, '[REDACTED]');
  const bytes = Buffer.from(sanitized, 'utf8');
  return bytes.byteLength <= 512 ? sanitized : bytes.subarray(0, 512).toString('utf8');
}

function aclFailureCause(error: unknown, path: string, sid?: string): Error {
  const value = error as { readonly code?: unknown; readonly stderr?: unknown };
  const exitCode = typeof value.code === 'number' && Number.isSafeInteger(value.code) ? value.code : undefined;
  const stderr = typeof value.stderr === 'string' ? boundedAclStderr(value.stderr, path, sid) : undefined;
  const message = [
    exitCode === undefined ? 'Windows ACL process failed' : `Windows ACL process exited with code ${exitCode}`,
    stderr === undefined ? undefined : `stderr=${stderr}`,
  ].filter((part): part is string => part !== undefined).join('; ');
  const boundedMessage = Buffer.byteLength(message, 'utf8') <= 512
    ? message : Buffer.from(message, 'utf8').subarray(0, 512).toString('utf8');
  const cause = new Error(boundedMessage);
  (cause as Error & { code: string }).code = 'BUNGEE_WINDOWS_ACL_PROCESS';
  return cause;
}

function aclEnvironment(path: string, sid?: string, kind?: 'directory' | 'file'): NodeJS.ProcessEnv {
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'psmodulepath', 'comspec']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) environment[key] = value;
  }
  environment.BUNGEE_DAEMON_ACL_PATH = path;
  if (sid !== undefined) environment.BUNGEE_DAEMON_ACL_SID = sid;
  if (kind !== undefined) environment.BUNGEE_DAEMON_ACL_KIND = kind;
  return environment;
}

function defaultWindowsAclAdapter(): WindowsAclAdapter {
  const readScript = '$a=Get-Acl -LiteralPath $env:BUNGEE_DAEMON_ACL_PATH;'
    + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'
    + '$e=@($a.Access|ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;'
    + 'access=$(if([int]$_.AccessControlType -eq 0){"allow"}else{"deny"});rights=[int]$_.FileSystemRights;'
    + 'inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=[bool]$_.IsInherited} });'
    + '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 @{currentSid=$sid;entries=$e}))';
  const setScript = '$p=$env:BUNGEE_DAEMON_ACL_PATH;$u=$env:BUNGEE_DAEMON_ACL_SID;'
    + '$k=$env:BUNGEE_DAEMON_ACL_KIND;$a=Get-Acl -LiteralPath $p;$a.SetAccessRuleProtection($true,$false);'
    + '$a.Access|ForEach-Object {$a.RemoveAccessRule($_)|Out-Null};$r=[System.Security.AccessControl.FileSystemRights]::FullControl;'
    + '$i=if($k -eq "directory"){[System.Security.AccessControl.InheritanceFlags]3}else{[System.Security.AccessControl.InheritanceFlags]0};'
    + 'foreach($s in @($u,"S-1-5-18","S-1-5-32-544")){ $sid=[System.Security.Principal.SecurityIdentifier]::new($s);'
    + '$z=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,$r,$i,[System.Security.AccessControl.PropagationFlags]0,[System.Security.AccessControl.AccessControlType]0);$a.AddAccessRule($z)};Set-Acl -LiteralPath $p -AclObject $a';
  return {
    async read(path) {
      try {
        const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(readScript)], { ...WINDOWS_ACL_EXEC_OPTIONS, env: aclEnvironment(path) });
        const value = JSON.parse(stdout) as WindowsAclSnapshot;
        if (!canonicalSid(value.currentSid) || !Array.isArray(value.entries)) fail('acl', 'Windows ACL probe was invalid');
        return value;
      } catch (error) { fail('acl', 'Windows ACL probe failed', aclFailureCause(error, path)); }
    },
    async set(path, currentSid, kind) {
      if (!canonicalSid(currentSid) || kind === undefined) fail('acl', 'Windows ACL update arguments are invalid');
      try { await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(setScript)], { ...WINDOWS_ACL_EXEC_OPTIONS, env: aclEnvironment(path, currentSid, kind) }); }
      catch (error) { fail('acl', 'Windows ACL update failed', aclFailureCause(error, path, currentSid)); }
    },
  };
}

async function fsyncDirectory(root: string, platform: NodeJS.Platform): Promise<void> {
  const unsupported = platform === 'win32' ? WINDOWS_UNSUPPORTED_FSYNC : POSIX_UNSUPPORTED_FSYNC;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    if (!unsupported.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    if (handle !== undefined) {
      try { await handle.close(); }
      catch (error) { if (!unsupported.has((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  }
}

async function writeAndVerify(handle: Awaited<ReturnType<typeof open>>, target: string, root: string, bytes: Uint8Array, options: DaemonFileOptions, expected?: FileIdentity, verifyAclBeforeWrite = false): Promise<FileIdentity> {
  const platform = currentPlatform(options);
  const before = await handle.stat();
  assertDescriptor(before, expected, platform);
  if (platform !== 'win32') await handle.chmod(0o600);
  const secured = await handle.stat();
  assertDescriptor(secured, expected, platform);
  if (platform !== 'win32' && mode(secured) !== 0o600) fail('permissions', 'temporary metadata file is not 0600');
  await verifyLstat(target, identity(secured), platform, 0o600);
  if (verifyAclBeforeWrite && platform === 'win32') {
    await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file');
  }
  await handle.writeFile(bytes);
  await handle.sync();
  const after = await handle.stat();
  assertDescriptor(after, identity(secured), platform);
  if (after.size !== bytes.byteLength || (platform !== 'win32' && mode(after) !== 0o600)) fail('race', 'temporary metadata file changed while writing');
  await verifyLstat(target, identity(after), platform, 0o600);
  if (platform === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file');
  return identity(after);
}

async function atomicReplace(target: string, root: string, bytes: Uint8Array, options: DaemonFileOptions): Promise<void> {
  const temporary = join(root, `.${METADATA_FILENAME}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let temporaryIdentity: FileIdentity | undefined;
  try {
    const opened = await handle.stat();
    assertDescriptor(opened, undefined, currentPlatform(options));
    temporaryIdentity = identity(opened);
    const writtenIdentity = await writeAndVerify(handle, temporary, root, bytes, options);
    if (!sameIdentity(temporaryIdentity, writtenIdentity)) fail('race', 'temporary metadata identity changed');
    await handle.close();
    await rename(temporary, target);
    await verifyLstat(target, temporaryIdentity, currentPlatform(options), 0o600);
    if (currentPlatform(options) === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file');
    await fsyncDirectory(root, currentPlatform(options));
  } catch (error) {
    try { await handle.close(); } catch { /* best effort */ }
    if (temporaryIdentity !== undefined) await removeOwnedFile(temporary, temporaryIdentity);
    throw error;
  }
}

export async function readDaemonMetadataFile(path: string, options: DaemonFileOptions): Promise<DaemonMetadataV1> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try { return (await readEvidence(path, options)).metadata; }
    catch (error) {
      if (!(error instanceof DaemonFileError) || error.code !== 'race' || attempt === 3) throw error;
    }
  }
  fail('race', 'metadata read retries were exhausted');
}

const LEGAL_TRANSITIONS: Readonly<Record<DaemonMetadataState, readonly DaemonMetadataState[]>> = {
  launching: ['starting'], starting: ['armed'], armed: ['stopping'], stopping: [],
};

export type DaemonMetadataTransition = {
  readonly expectedBootNonce: string;
  readonly expectedState: DaemonMetadataState;
  readonly expectedShutdownSecret: string;
  readonly next: DaemonMetadataV1;
};

function sameImmutable(left: DaemonMetadataV1, right: DaemonMetadataV1): boolean {
  return left.schema === right.schema && left.launcher_pid === right.launcher_pid && left.boot_nonce === right.boot_nonce
    && left.shutdown_secret === right.shutdown_secret && left.executable === right.executable && left.entrypoint === right.entrypoint;
}

function validTransition(current: DaemonMetadataV1, next: DaemonMetadataV1): boolean {
  if (!LEGAL_TRANSITIONS[current.state].includes(next.state) || !sameImmutable(current, next)) return false;
  if (current.state === 'starting' && (next.state !== 'armed' || next.pid !== current.pid)) return false;
  if (current.state === 'armed' && (next.state !== 'stopping' || next.pid !== current.pid
    || next.instance_id !== current.instance_id || next.management_host !== current.management_host
    || next.management_port !== current.management_port)) return false;
  return true;
}

export async function transitionDaemonMetadataFile(path: string, transition: DaemonMetadataTransition, options: DaemonFileOptions): Promise<DaemonMetadataV1> {
  const first = await readEvidence(path, options);
  if (first.metadata.boot_nonce !== transition.expectedBootNonce || first.metadata.state !== transition.expectedState) fail('state', 'metadata owner or state does not match');
  if (first.metadata.shutdown_secret !== transition.expectedShutdownSecret) fail('secret', 'metadata secret does not match');
  if (!validTransition(first.metadata, transition.next)) fail('transition', 'metadata state transition is illegal or mutates ownership');
  const second = await readEvidence(path, options);
  if (!sameIdentity(first.identity, second.identity) || !bytesEqual(first.bytes, second.bytes)) fail('race', 'metadata changed before transition');
  await atomicReplace(first.target, first.root, new TextEncoder().encode(encodeDaemonMetadataV1(transition.next)), options);
  return transition.next;
}

export type DaemonMetadataDeleteExpectation = {
  readonly bootNonce: string;
  readonly state: DaemonMetadataState;
  readonly shutdownSecret: string;
};

export type DaemonMetadataMasterDeleteExpectation = {
  readonly bootNonce: string;
  readonly shutdownSecret: string;
  readonly pid: number;
};

/**
 * Deletes metadata only after the caller has independently proven the owner is dead.
 * This is a guarded delete, not a cross-process CAS primitive.
 */
export async function deleteDaemonMetadataAfterOwnerExit(path: string, expected: DaemonMetadataDeleteExpectation, options: DaemonFileOptions): Promise<boolean> {
  let first: ReadEvidence;
  try { first = await readEvidence(path, options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (first.metadata.boot_nonce !== expected.bootNonce || first.metadata.state !== expected.state
    || first.metadata.shutdown_secret !== expected.shutdownSecret) return false;
  let second: ReadEvidence;
  try { second = await readEvidence(path, options); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  if (!sameIdentity(first.identity, second.identity) || !bytesEqual(first.bytes, second.bytes)) fail('race', 'metadata changed before delete');
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options));
  return true;
}

export type DaemonMetadataLauncherDeleteExpectation = {
  readonly bootNonce: string;
  readonly shutdownSecret: string;
};

/** Deletes a launch record owned by the current CLI process. */
export async function deleteDaemonMetadataForLauncher(
  path: string,
  expected: DaemonMetadataLauncherDeleteExpectation,
  options: DaemonFileOptions,
): Promise<boolean> {
  if (process.pid <= 0) fail('owner', 'current process pid is invalid');
  const first = await readEvidence(path, options);
  if (first.metadata.state !== 'launching' || first.metadata.launcher_pid !== process.pid
    || first.metadata.boot_nonce !== expected.bootNonce
    || first.metadata.shutdown_secret !== expected.shutdownSecret) return false;
  const second = await readEvidence(path, options);
  if (!sameIdentity(first.identity, second.identity) || !bytesEqual(first.bytes, second.bytes)) {
    fail('race', 'metadata changed before launcher delete');
  }
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options));
  return true;
}

/** Deletes the current master's stopping record after runtime cleanup succeeds. */
export async function deleteDaemonMetadataForMaster(
  path: string,
  expected: DaemonMetadataMasterDeleteExpectation,
  options: DaemonFileOptions,
): Promise<boolean> {
  if (expected.pid !== process.pid) fail('owner', 'metadata pid is not the current process');
  const first = await readEvidence(path, options);
  if (first.metadata.state !== 'stopping' || first.metadata.boot_nonce !== expected.bootNonce
    || first.metadata.shutdown_secret !== expected.shutdownSecret || first.metadata.pid !== expected.pid) {
    fail('state', 'metadata is not the expected stopping record for this master');
  }
  const second = await readEvidence(path, options);
  if (!sameIdentity(first.identity, second.identity) || !bytesEqual(first.bytes, second.bytes)) {
    fail('race', 'metadata changed before master delete');
  }
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options));
  return true;
}

export async function createLaunchingDaemonMetadataFile(path: string, metadata: DaemonMetadataV1, options: DaemonFileOptions): Promise<void> {
  if (metadata.state !== 'launching') fail('state', 'launch metadata must be launching');
  const safe = await secureTarget(path, options, false);
  const bytes = new TextEncoder().encode(encodeDaemonMetadataV1(metadata));
  const handle = await open(safe.target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let createdIdentity: FileIdentity | undefined;
  try {
    const opened = await handle.stat();
    assertDescriptor(opened, undefined, currentPlatform(options));
    createdIdentity = identity(opened);
    await writeAndVerify(handle, safe.target, safe.root, bytes, options, createdIdentity, true);
    await handle.close();
    await fsyncDirectory(safe.root, currentPlatform(options));
  } catch (error) {
    try { await handle.close(); } catch { /* best effort */ }
    if (createdIdentity !== undefined) await removeOwnedFile(safe.target, createdIdentity);
    throw error;
  }
}
