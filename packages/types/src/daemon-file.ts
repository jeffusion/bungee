import { randomBytes } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, normalize, parse, relative, resolve, win32 } from 'node:path';
import type { DaemonMetadataState, DaemonMetadataV1 } from './daemon-control.js';
import { decodeDaemonMetadataV1, encodeDaemonMetadataV1 } from './daemon-control.js';

const MAX_BYTES = 4 * 1024;
const METADATA_FILENAME = 'daemon.json';
const WINDOWS_SYSTEM = 'S-1-5-18';
const WINDOWS_ADMINISTRATORS = 'S-1-5-32-544';
const WINDOWS_FULL_CONTROL = 2_032_127;
const WINDOWS_CONTAINER_INHERIT = 1;
const WINDOWS_OBJECT_INHERIT = 2;
const WINDOWS_ACL_EXEC_OPTIONS = {
  windowsHide: true,
};
const WINDOWS_ACL_DEADLINE_MS = 10_000;
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 64 * 1024;
const WINDOWS_ACL_PHASE_PREFIX = '__BUNGEE_ACL_PHASE__:';
const WINDOWS_ACL_PHASES = new Set(['started', 'before_get_acl', 'after_get_acl', 'before_set_acl', 'after_set_acl']);
const WINDOWS_ACL_SIGNALS = new Set([
  'SIGABRT', 'SIGALRM', 'SIGHUP', 'SIGINT', 'SIGKILL', 'SIGPIPE', 'SIGQUIT', 'SIGTERM',
  'SIGUSR1', 'SIGUSR2', 'SIGCONT', 'SIGSTOP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU',
]);
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
  const canonicalRoot = await secureRuntimeDirectory(options, !mustExist);
  await rejectSymlinkComponents(targetPath);
  const target = resolve(canonicalRoot, METADATA_FILENAME);
  try {
    const item = await lstat(target);
    if (item.isSymbolicLink()) fail('symlink', 'metadata file must not be a symlink');
    if (!item.isFile() || item.nlink !== 1) fail('file', 'metadata file must be a single regular file');
    if (platform !== 'win32' && typeof process.geteuid === 'function' && item.uid !== process.geteuid()) fail('owner', 'metadata owner is invalid');
    if (platform === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file');
    const canonical = await realpath(target);
    if (!contained(canonicalRoot, canonical, platform)) fail('containment', 'metadata file escaped the runtime root');
    return { root: canonicalRoot, target, initial: identity(item) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mustExist) throw error;
    return { root: canonicalRoot, target };
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

type WindowsAclProcessDiagnostic = Readonly<{
  operation: 'read' | 'set';
  outcome: 'exit' | 'timeout' | 'signal' | 'spawn_error';
  elapsed_ms: number;
  exit_code: number | null;
  signal: string | null;
  killed: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  last_phase: 'started' | 'before_get_acl' | 'after_get_acl' | 'before_set_acl' | 'after_set_acl' | null;
  psmodulepath_present: false;
  systemroot_present: boolean;
}>;

type WindowsAclProcessResult = WindowsAclProcessDiagnostic & { readonly stdout: string };

class WindowsAclProcessError extends Error {
  readonly code = 'BUNGEE_WINDOWS_ACL_PROCESS';
  constructor(readonly diagnostic: WindowsAclProcessDiagnostic) {
    super(JSON.stringify(diagnostic));
    this.name = 'WindowsAclProcessError';
  }
}

function boundedElapsed(startedAt: number, deadlineMs: number): number {
  return Math.min(deadlineMs, Math.max(0, Date.now() - startedAt));
}

function allowedSignal(signal: NodeJS.Signals | null): string | null {
  return signal !== null && WINDOWS_ACL_SIGNALS.has(signal) ? signal : null;
}

function processDiagnostic(
  operation: 'read' | 'set',
  startedAt: number,
  phase: WindowsAclProcessDiagnostic['last_phase'],
  environment: NodeJS.ProcessEnv,
  deadlineMs: number,
  result: { readonly outcome: WindowsAclProcessDiagnostic['outcome']; readonly exitCode?: number | null; readonly signal?: NodeJS.Signals | null; readonly killed: boolean; readonly stdoutBytes: number; readonly stderrBytes: number },
): WindowsAclProcessDiagnostic {
  return {
    operation,
    outcome: result.outcome,
    elapsed_ms: boundedElapsed(startedAt, deadlineMs),
    exit_code: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: allowedSignal(result.signal ?? null),
    killed: result.killed,
    stdout_bytes: Math.min(WINDOWS_ACL_MAX_OUTPUT_BYTES, result.stdoutBytes),
    stderr_bytes: Math.min(WINDOWS_ACL_MAX_OUTPUT_BYTES, result.stderrBytes),
    last_phase: phase,
    psmodulepath_present: false,
    systemroot_present: Object.keys(environment).some((key) => key.toLowerCase() === 'systemroot'),
  };
}

async function runPowerShell(
  operation: 'read' | 'set',
  script: string,
  environment: NodeJS.ProcessEnv,
  deadlineMs: number,
): Promise<WindowsAclProcessResult> {
  const startedAt = Date.now();
  let phase: WindowsAclProcessDiagnostic['last_phase'] = null;
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], {
      ...WINDOWS_ACL_EXEC_OPTIONS,
      env: environment,
    });
  } catch {
    const diagnostic = processDiagnostic(operation, startedAt, phase, environment, deadlineMs, {
      outcome: 'spawn_error', killed: false, stdoutBytes: 0, stderrBytes: 0,
    });
    throw new WindowsAclProcessError(diagnostic);
  }

  let stdout = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let phaseText = '';
  let killed = false;
  let timedOut = false;
  let spawnError = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let exited = false;
  let closed = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const result = await new Promise<WindowsAclProcessResult>((resolve, reject) => {
    const settle = () => {
      if (settled || !closed) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      const outcome = spawnError ? 'spawn_error' : timedOut ? 'timeout' : exitSignal !== null ? 'signal' : 'exit';
      const diagnostic = processDiagnostic(operation, startedAt, phase, environment, deadlineMs, {
        outcome, exitCode, signal: exitSignal, killed, stdoutBytes, stderrBytes,
      });
      if (outcome === 'exit' && exitCode === 0) resolve({ ...diagnostic, stdout });
      else reject(new WindowsAclProcessError(diagnostic));
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const bytes = Buffer.byteLength(chunk);
      stdoutBytes += bytes;
      if (stdoutBytes <= WINDOWS_ACL_MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString();
      stderrBytes += Buffer.byteLength(text);
      phaseText = `${phaseText}${text}`.slice(-256);
      const matches = phaseText.matchAll(new RegExp(`${escapeRegExp(WINDOWS_ACL_PHASE_PREFIX)}(started|before_get_acl|after_get_acl|before_set_acl|after_set_acl)`, 'gu'));
      for (const match of matches) {
        const next = match[1];
        if (next !== undefined && WINDOWS_ACL_PHASES.has(next)) phase = next as WindowsAclProcessDiagnostic['last_phase'];
      }
    });
    child.once('error', () => { spawnError = true; settle(); });
    child.once('exit', (code, signal) => {
      exited = true;
      exitCode = code;
      exitSignal = signal;
      settle();
    });
    child.once('close', () => { closed = true; settle(); });
    timer = setTimeout(() => {
      if (exited || settled) return;
      timedOut = true;
      killed = child.kill('SIGKILL');
    }, deadlineMs);
  });
  return result;
}

function aclEnvironment(path: string, sid?: string, kind?: 'directory' | 'file'): NodeJS.ProcessEnv {
  const allowed = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec']);
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.has(key.toLowerCase()) && value !== undefined) environment[key] = value;
  }
  environment.BUNGEE_DAEMON_ACL_PATH = path;
  if (sid !== undefined) environment.BUNGEE_DAEMON_ACL_SID = sid;
  if (kind !== undefined) environment.BUNGEE_DAEMON_ACL_KIND = kind;
  return environment;
}

function defaultWindowsAclAdapter(deadlineMs = WINDOWS_ACL_DEADLINE_MS): WindowsAclAdapter {
  const phase = (value: string) => `[Console]::Error.WriteLine('${WINDOWS_ACL_PHASE_PREFIX}${value}');`;
  const moduleBootstrap = '$env:PSModulePath=[System.IO.Path]::Combine($PSHOME,"Modules");'
    + 'Import-Module Microsoft.PowerShell.Security -ErrorAction Stop;';
  const readScript = phase('started') + moduleBootstrap + phase('before_get_acl') + '$a=Get-Acl -LiteralPath $env:BUNGEE_DAEMON_ACL_PATH;'
    + phase('after_get_acl')
    + '$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value;'
    + '$e=@($a.Access|ForEach-Object { @{sid=$_.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value;'
    + 'access=$(if([int]$_.AccessControlType -eq 0){"allow"}else{"deny"});rights=[int]$_.FileSystemRights;'
    + 'inheritance=[int]$_.InheritanceFlags;propagation=[int]$_.PropagationFlags;inherited=[bool]$_.IsInherited} });'
    + '[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 @{currentSid=$sid;entries=$e}))';
  const setScript = phase('started') + moduleBootstrap + '$p=$env:BUNGEE_DAEMON_ACL_PATH;$u=$env:BUNGEE_DAEMON_ACL_SID;'
    + '$k=$env:BUNGEE_DAEMON_ACL_KIND;' + phase('before_get_acl') + '$a=Get-Acl -LiteralPath $p;' + phase('after_get_acl') + '$a.SetAccessRuleProtection($true,$false);'
    + '$a.Access|ForEach-Object {$a.RemoveAccessRule($_)|Out-Null};$r=[System.Security.AccessControl.FileSystemRights]::FullControl;'
    + '$i=if($k -eq "directory"){[System.Security.AccessControl.InheritanceFlags]3}else{[System.Security.AccessControl.InheritanceFlags]0};'
    + 'foreach($s in @($u,"S-1-5-18","S-1-5-32-544")){ $sid=[System.Security.Principal.SecurityIdentifier]::new($s);'
    + '$z=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,$r,$i,[System.Security.AccessControl.PropagationFlags]0,[System.Security.AccessControl.AccessControlType]0);$a.AddAccessRule($z)};'
    + phase('before_set_acl') + 'Set-Acl -LiteralPath $p -AclObject $a;' + phase('after_set_acl');
  return {
    async read(path) {
      let diagnostic: WindowsAclProcessDiagnostic | undefined;
      try {
        const result = await runPowerShell('read', readScript, aclEnvironment(path), deadlineMs);
        const { stdout, ...completedDiagnostic } = result;
        diagnostic = completedDiagnostic;
        const value = JSON.parse(stdout) as WindowsAclSnapshot;
        if (!canonicalSid(value.currentSid) || !Array.isArray(value.entries)) fail('acl', 'Windows ACL probe was invalid');
        return value;
      } catch (error) {
        if (error instanceof WindowsAclProcessError) fail('acl', 'Windows ACL probe failed', error);
        fail('acl', 'Windows ACL probe was invalid', new WindowsAclProcessError(diagnostic!));
      }
    },
    async set(path, currentSid, kind) {
      if (!canonicalSid(currentSid) || kind === undefined) fail('acl', 'Windows ACL update arguments are invalid');
      try { await runPowerShell('set', setScript, aclEnvironment(path, currentSid, kind), deadlineMs); }
      catch (error) {
        if (error instanceof WindowsAclProcessError) fail('acl', 'Windows ACL update failed', error);
        fail('acl', 'Windows ACL update failed');
      }
    },
  };
}

/** @internal source-test probe; not re-exported from the package root. */
export async function __testReadWindowsAcl(path: string, deadlineMs = WINDOWS_ACL_DEADLINE_MS): Promise<WindowsAclSnapshot> {
  return defaultWindowsAclAdapter(deadlineMs).read(path);
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
