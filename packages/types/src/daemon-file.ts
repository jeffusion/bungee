import { randomBytes } from 'node:crypto';
import { constants as fsConstants, existsSync } from 'node:fs';
import { chmod, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { isAbsolute, join, normalize, parse, relative, resolve, win32 } from 'node:path';
import type { DaemonMetadataState, DaemonMetadataV1 } from './daemon-control.js';
import { decodeDaemonMetadataV1, encodeDaemonMetadataV1 } from './daemon-control.js';

const MAX_BYTES = 4 * 1024;
const METADATA_FILENAME = 'daemon.json';
const WINDOWS_RENAME_RETRIES = 3;
const WINDOWS_RENAME_RETRY_DELAY_MS = 25;
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
const WINDOWS_ACL_OPERATIONS = new Set(['read', 'set']);
const WINDOWS_ACL_OUTCOMES = new Set(['exit', 'timeout', 'signal', 'spawn_error']);
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

/** Test-only evidence points for the create-launching primitive. */
export type DaemonFileTestStage =
  | 'runtime_components' | 'runtime_lstat' | 'runtime_mkdir' | 'runtime_created_lstat'
  | 'runtime_realpath' | 'profile_realpath' | 'directory_acl'
  | 'target_components' | 'target_lstat' | 'target_realpath' | 'create_open'
  | 'descriptor_stat' | 'verify_lstat' | 'file_acl' | 'file_write' | 'file_sync' | 'file_close';

export type DaemonFileOptions = {
  /** The trusted, canonical runtime root. The only accepted target is root/daemon.json. */
  readonly runtimeDirectory: string;
  /** Test-only platform injection; production leaves this unset. */
  readonly platform?: NodeJS.Platform;
  readonly windowsAcl?: WindowsAclAdapter;
  /** Deterministic race injection for the metadata primitive tests. */
  readonly testHooks?: {
    readonly onStage?: (stage: DaemonFileTestStage) => void;
    readonly afterOpen?: (target: string) => void | Promise<void>;
    readonly afterInitialStat?: (target: string) => void | Promise<void>;
    readonly rename?: (from: string, to: string) => Promise<void>;
    readonly sleep?: (milliseconds: number) => Promise<void>;
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
function testStage(options: DaemonFileOptions | undefined, stage: DaemonFileTestStage): void {
  options?.testHooks?.onStage?.(stage);
}

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

function canonicalSid(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  return SID.test(value) && value.slice(2).split('-').every((part) => part === '0' || !part.startsWith('0'));
}

function identity(stat: { readonly dev: bigint | number; readonly ino: bigint | number }): FileIdentity {
  return { dev: String(stat.dev), ino: String(stat.ino) };
}

function mode(stat: { readonly mode: number }): number { return stat.mode & 0o777; }

async function rejectSymlinkComponents(path: string, options: DaemonFileOptions, stage: 'runtime_components' | 'target_components'): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(/[\\/]+/).filter(Boolean)) {
    current = resolve(current, part);
    testStage(options, stage);
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
  testStage(options, 'profile_realpath');
  try {
    return await realpath(profile);
  }
  catch { fail('containment', 'USERPROFILE cannot be canonicalized'); }
}

async function secureRuntimeDirectory(options: DaemonFileOptions, allowCreate: boolean): Promise<string> {
  const requested = options.runtimeDirectory;
  if (!isAbsolute(requested) || requested.includes('\0')) fail('path', 'runtime directory must be absolute and NUL-free');
  await rejectSymlinkComponents(requested, options, 'runtime_components');
  const platform = currentPlatform(options);
  let runtimePath = requested;
  let canonicalRuntimePath: string | undefined;
  let before;
  testStage(options, 'runtime_lstat');
  try {
    before = await lstat(runtimePath);
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (platform === 'win32') {
      testStage(options, 'runtime_realpath');
      try {
        canonicalRuntimePath = await realpath(requested);
      }
      catch (realpathError) {
        if ((realpathError as NodeJS.ErrnoException).code !== 'ENOENT') throw realpathError;
      }
    }
    if (canonicalRuntimePath !== undefined) {
      runtimePath = canonicalRuntimePath;
      await rejectSymlinkComponents(runtimePath, options, 'runtime_components');
      testStage(options, 'runtime_lstat');
      before = await lstat(runtimePath);
    } else {
      if (!allowCreate) throw error;
      testStage(options, 'runtime_mkdir');
      await mkdir(requested, { recursive: true, mode: 0o700 });
      testStage(options, 'runtime_created_lstat');
      before = await lstat(requested);
    }
  }
  if (!before.isDirectory() || before.isSymbolicLink()) fail('directory', 'runtime directory is not a real directory');
  let root = canonicalRuntimePath;
  if (root === undefined) {
    testStage(options, 'runtime_realpath');
    root = await realpath(runtimePath);
  }
  if (platform === 'win32') {
    const profile = await canonicalProfile(options);
    if (!contained(profile, root, platform)) fail('containment', 'runtime directory must be a strict child of USERPROFILE');
    // Profile containment is deliberately before any ACL adapter call.
    await ensureWindowsAcl(root, options.windowsAcl ?? defaultWindowsAclAdapter(), 'directory', options);
  } else {
    if (typeof process.geteuid === 'function' && before.uid !== process.geteuid()) fail('owner', 'runtime directory owner is invalid');
    if (mode(before) !== 0o700) await chmod(runtimePath, 0o700);
    const after = await lstat(runtimePath);
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
  await rejectSymlinkComponents(targetPath, options, 'target_components');
  const target = resolve(canonicalRoot, METADATA_FILENAME);
  testStage(options, 'target_lstat');
  try {
    const item = await lstat(target);
    if (item.isSymbolicLink()) fail('symlink', 'metadata file must not be a symlink');
    if (!item.isFile() || item.nlink !== 1) fail('file', 'metadata file must be a single regular file');
    if (platform !== 'win32' && typeof process.geteuid === 'function' && item.uid !== process.geteuid()) fail('owner', 'metadata owner is invalid');
    if (platform === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file', options);
    testStage(options, 'target_realpath');
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

async function verifyLstat(target: string, expected: FileIdentity, platform: NodeJS.Platform, expectedMode: number | undefined, options?: DaemonFileOptions): Promise<ReturnType<typeof identity>> {
  testStage(options, 'verify_lstat');
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
    testStage(options, 'descriptor_stat');
    const opened = await handle.stat();
    assertDescriptor(opened, safe.initial, platform);
    if (opened.size > MAX_BYTES) fail('limit', 'daemon metadata file exceeds 4 KiB');
    if (platform !== 'win32' && mode(opened) !== 0o600) await handle.chmod(0o600);
    testStage(options, 'descriptor_stat');
    const secured = await handle.stat();
    assertDescriptor(secured, safe.initial, platform);
    if (platform !== 'win32' && mode(secured) !== 0o600) fail('permissions', 'metadata file permissions are not exact');
    await verifyLstat(safe.target, safe.initial, platform, 0o600, options);
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
    testStage(options, 'descriptor_stat');
    const finalStat = await handle.stat();
    assertDescriptor(finalStat, safe.initial, platform);
    if (finalStat.size !== total || finalStat.size !== opened.size) fail('race', 'metadata file size changed while reading');
    await verifyLstat(safe.target, safe.initial, platform, 0o600, options);
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const metadata = decodeDaemonMetadataV1(bytes);
    const canonical = new TextEncoder().encode(encodeDaemonMetadataV1(metadata));
    if (!bytesEqual(bytes, canonical)) fail('invalid', 'metadata bytes are not canonical');
    return { target: safe.target, root: safe.root, bytes: canonical, identity: safe.initial, metadata };
  } finally {
    testStage(options, 'file_close');
    await handle.close();
  }
}

async function ensureWindowsAcl(path: string, adapter: WindowsAclAdapter, kind: 'directory' | 'file', options?: DaemonFileOptions): Promise<void> {
  testStage(options, kind === 'directory' ? 'directory_acl' : 'file_acl');
  let snapshot = await adapter.read(path);
  let validation = windowsAclSecure(snapshot, kind);
  if (validation?.reason === 'invalid_current_sid') throw new WindowsAclValidationError(validation);
  if (validation !== null) {
    testStage(options, kind === 'directory' ? 'directory_acl' : 'file_acl');
    await adapter.set(path, snapshot.currentSid, kind);
  }
  testStage(options, kind === 'directory' ? 'directory_acl' : 'file_acl');
  snapshot = await adapter.read(path);
  validation = windowsAclSecure(snapshot, kind);
  if (validation !== null) throw new WindowsAclValidationError(validation);
}

type WindowsAclValidationReason =
  | 'invalid_current_sid' | 'unexpected_sid' | 'missing_sid' | 'access_type'
  | 'rights' | 'inheritance' | 'propagation' | 'inherited';

type WindowsAclValidation = Readonly<{
  reason: WindowsAclValidationReason;
  targetKind: 'directory' | 'file';
  entriesCount: number;
  unexpectedCount: number;
  inheritedCount: number;
  missingCount: number;
}>;

const WINDOWS_ACL_VALIDATION_REASONS = new Set<WindowsAclValidationReason>([
  'invalid_current_sid', 'unexpected_sid', 'missing_sid', 'access_type',
  'rights', 'inheritance', 'propagation', 'inherited',
]);
const WINDOWS_ACL_TARGET_KINDS = new Set(['directory', 'file']);
const MAX_WINDOWS_ACL_EVIDENCE_COUNT = 1_024;

function boundedAclCount(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isSafeInteger(value)) return 0;
  return Math.min(MAX_WINDOWS_ACL_EVIDENCE_COUNT, Math.max(0, value));
}

function windowsAclSecure(snapshot: WindowsAclSnapshot, kind: 'directory' | 'file'): WindowsAclValidation | null {
  const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
  const currentSid = snapshot?.currentSid;
  const validCurrentSid = canonicalSid(currentSid);
  const allowed = new Set(validCurrentSid ? [currentSid, WINDOWS_SYSTEM, WINDOWS_ADMINISTRATORS] : [WINDOWS_SYSTEM, WINDOWS_ADMINISTRATORS]);
  const missing = new Set(allowed);
  const inheritance = kind === 'directory' ? WINDOWS_CONTAINER_INHERIT | WINDOWS_OBJECT_INHERIT : 0;
  let reason: WindowsAclValidationReason | undefined = validCurrentSid ? undefined : 'invalid_current_sid';
  let unexpectedCount = 0;
  let inheritedCount = 0;
  for (const entry of entries) {
    if (entry?.inherited === true) inheritedCount += 1;
    if (!canonicalSid(entry?.sid) || !allowed.has(entry.sid)) {
      unexpectedCount += 1;
      reason ??= 'unexpected_sid';
      continue;
    }
    missing.delete(entry.sid);
    if (entry.access !== 'allow') reason ??= 'access_type';
    else if (entry.rights !== WINDOWS_FULL_CONTROL) reason ??= 'rights';
    else if (entry.inheritance !== inheritance) reason ??= 'inheritance';
    else if (entry.propagation !== 0) reason ??= 'propagation';
    else if (entry.inherited) reason ??= 'inherited';
  }
  if (reason === undefined && missing.size !== 0) reason = 'missing_sid';
  if (reason === undefined) return null;
  return {
    reason,
    targetKind: kind,
    entriesCount: boundedAclCount(entries.length),
    unexpectedCount: boundedAclCount(unexpectedCount),
    inheritedCount: boundedAclCount(inheritedCount),
    missingCount: boundedAclCount(missing.size),
  };
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
  spawn_event: boolean;
  exit_event: boolean;
  close_event: boolean;
  kill_returned_true: boolean;
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

class WindowsAclValidationError extends DaemonFileError {
  readonly reason: WindowsAclValidationReason;
  readonly targetKind: 'directory' | 'file';
  readonly entriesCount: number;
  readonly unexpectedCount: number;
  readonly inheritedCount: number;
  readonly missingCount: number;

  constructor(validation: WindowsAclValidation) {
    super('acl', 'Windows ACL validation failed');
    this.reason = validation.reason;
    this.targetKind = validation.targetKind;
    this.entriesCount = validation.entriesCount;
    this.unexpectedCount = validation.unexpectedCount;
    this.inheritedCount = validation.inheritedCount;
    this.missingCount = validation.missingCount;
  }
}

/** Formats only the bounded, allowlisted fields safe for exposing a Windows ACL failure. */
export function formatDaemonFileAclError(error: unknown): string | null {
  if (!(error instanceof DaemonFileError) || error.code !== 'acl') return null;
  if (error instanceof WindowsAclValidationError) {
    const reason = WINDOWS_ACL_VALIDATION_REASONS.has(error.reason) ? error.reason : 'unknown';
    const targetKind = WINDOWS_ACL_TARGET_KINDS.has(error.targetKind) ? error.targetKind : 'unknown';
    return `acl_reason=${reason} target_kind=${targetKind}`
      + ` entries_count=${boundedAclCount(error.entriesCount)}`
      + ` unexpected_count=${boundedAclCount(error.unexpectedCount)}`
      + ` inherited_count=${boundedAclCount(error.inheritedCount)}`
      + ` missing_count=${boundedAclCount(error.missingCount)}`;
  }
  const cause = (error as Error & { readonly cause?: unknown }).cause;
  if (!(cause instanceof WindowsAclProcessError)) return null;
  const diagnostic = cause.diagnostic;
  const operation = WINDOWS_ACL_OPERATIONS.has(diagnostic.operation) ? diagnostic.operation : 'unknown';
  const outcome = WINDOWS_ACL_OUTCOMES.has(diagnostic.outcome) ? diagnostic.outcome : 'unknown';
  const lastPhase = diagnostic.last_phase === null ? 'null' : WINDOWS_ACL_PHASES.has(diagnostic.last_phase) ? diagnostic.last_phase : 'unknown';
  return `acl_operation=${operation} outcome=${outcome}`
    + ` last_phase=${lastPhase} kill_returned_true=${diagnostic.kill_returned_true === true}`
    + ` spawn_event=${diagnostic.spawn_event === true} exit_event=${diagnostic.exit_event === true}`
    + ` close_event=${diagnostic.close_event === true}`;
}

function boundedElapsed(startedAt: number, deadlineMs: number): number {
  return Math.min(deadlineMs, Math.max(0, Date.now() - startedAt));
}

function selectWindowsAclExecutable(environment: NodeJS.ProcessEnv): string {
  const programFiles = environment.ProgramFiles;
  if (programFiles !== undefined && isAbsolute(programFiles)) {
    const pwsh = join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    if (existsSync(pwsh)) return pwsh;
  }
  return 'powershell.exe';
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
  result: {
    readonly outcome: WindowsAclProcessDiagnostic['outcome']; readonly exitCode?: number | null;
    readonly signal?: NodeJS.Signals | null;
    readonly spawnEvent: boolean; readonly exitEvent: boolean; readonly closeEvent: boolean; readonly killReturnedTrue: boolean;
    readonly stdoutBytes: number; readonly stderrBytes: number;
  },
): WindowsAclProcessDiagnostic {
  return {
    operation,
    outcome: result.outcome,
    elapsed_ms: boundedElapsed(startedAt, deadlineMs),
    exit_code: typeof result.exitCode === 'number' ? result.exitCode : null,
    signal: allowedSignal(result.signal ?? null),
    spawn_event: result.spawnEvent,
    exit_event: result.exitEvent,
    close_event: result.closeEvent,
    kill_returned_true: result.killReturnedTrue,
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
    child = spawn(selectWindowsAclExecutable(process.env), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodedPowerShell(script)], {
      ...WINDOWS_ACL_EXEC_OPTIONS,
      env: environment,
    });
  } catch {
    const diagnostic = processDiagnostic(operation, startedAt, phase, environment, deadlineMs, {
      outcome: 'spawn_error', spawnEvent: false, exitEvent: false, closeEvent: false, killReturnedTrue: false,
      stdoutBytes: 0, stderrBytes: 0,
    });
    throw new WindowsAclProcessError(diagnostic);
  }

  let stdout = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let phaseText = '';
  let timedOut = false;
  let spawnError = false;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let spawnEvent = false;
  let exitEvent = false;
  let closeEvent = false;
  let killReturnedTrue = false;
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
        outcome, exitCode, signal: exitSignal, spawnEvent, exitEvent, closeEvent, killReturnedTrue, stdoutBytes, stderrBytes,
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
    child.once('spawn', () => { spawnEvent = true; });
    child.once('error', () => { spawnError = true; settle(); });
    child.once('exit', (code, signal) => {
      exitEvent = true;
      exited = true;
      exitCode = code;
      exitSignal = signal;
      settle();
    });
    child.once('close', () => { closeEvent = true; closed = true; settle(); });
    timer = setTimeout(() => {
      if (exited || settled) return;
      timedOut = true;
      try { killReturnedTrue = child.kill('SIGKILL') === true; }
      catch { killReturnedTrue = false; }
    }, deadlineMs);
  });
  return result;
}

/** @internal source-test probe; not re-exported from the package root. */
export function __testSelectWindowsAclExecutable(environment: NodeJS.ProcessEnv): string {
  return selectWindowsAclExecutable(environment);
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
    + '$k=$env:BUNGEE_DAEMON_ACL_KIND;$a=if($k -eq "directory"){[System.Security.AccessControl.DirectorySecurity]::new()}else{[System.Security.AccessControl.FileSecurity]::new()};'
    + '$f=if($k -eq "directory"){"OICI"}else{""};$sddl="O:$u"+"D:P(A;$f;FA;;;$u)(A;$f;FA;;;SY)(A;$f;FA;;;BA)";'
    + '$a.SetSecurityDescriptorSddlForm($sddl);'
    + phase('before_set_acl') + 'Set-Acl -LiteralPath $p -AclObject $a;' + phase('after_set_acl');
  return {
    async read(path) {
      let diagnostic: WindowsAclProcessDiagnostic | undefined;
      try {
        const result = await runPowerShell('read', readScript, aclEnvironment(path), deadlineMs);
        const { stdout, ...completedDiagnostic } = result;
        diagnostic = completedDiagnostic;
        const value = JSON.parse(stdout) as WindowsAclSnapshot;
        if (!Array.isArray(value.entries)) fail('acl', 'Windows ACL probe was invalid');
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

/** @internal source-test factory; not re-exported from the package root. */
export function __testCreateDaemonFileAclError(
  overrides: Readonly<Record<string, unknown>> = {},
): DaemonFileError {
  const operation = overrides.operation === 'read' || overrides.operation === 'set' ? overrides.operation : 'forged_operation';
  const outcome = overrides.outcome === 'exit' || overrides.outcome === 'timeout' || overrides.outcome === 'signal' || overrides.outcome === 'spawn_error'
    ? overrides.outcome : 'forged_outcome';
  const lastPhase = overrides.last_phase === null || overrides.last_phase === 'started' || overrides.last_phase === 'before_get_acl'
    || overrides.last_phase === 'after_get_acl' || overrides.last_phase === 'before_set_acl' || overrides.last_phase === 'after_set_acl'
    ? overrides.last_phase : 'forged_phase';
  const diagnostic = {
    operation, outcome, elapsed_ms: typeof overrides.elapsed_ms === 'number' ? overrides.elapsed_ms : 1,
    exit_code: typeof overrides.exit_code === 'number' ? overrides.exit_code : 17,
    signal: typeof overrides.signal === 'string' && WINDOWS_ACL_SIGNALS.has(overrides.signal) ? overrides.signal : null,
    spawn_event: overrides.spawn_event === true,
    exit_event: overrides.exit_event === true,
    close_event: overrides.close_event === true,
    kill_returned_true: overrides.kill_returned_true === true,
    stdout_bytes: typeof overrides.stdout_bytes === 'number' ? overrides.stdout_bytes : 0,
    stderr_bytes: typeof overrides.stderr_bytes === 'number' ? overrides.stderr_bytes : 0,
    last_phase: lastPhase,
    psmodulepath_present: false,
    systemroot_present: overrides.systemroot_present === true,
  } as unknown as WindowsAclProcessDiagnostic;
  return new DaemonFileError('acl', 'Windows ACL process failed', new WindowsAclProcessError(diagnostic));
}

async function fsyncDirectory(root: string, platform: NodeJS.Platform, options?: DaemonFileOptions): Promise<void> {
  const unsupported = platform === 'win32' ? WINDOWS_UNSUPPORTED_FSYNC : POSIX_UNSUPPORTED_FSYNC;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  testStage(options, 'file_sync');
  try {
    handle = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
    await handle.sync();
  } catch (error) {
    if (!unsupported.has((error as NodeJS.ErrnoException).code ?? '')) throw error;
  } finally {
    if (handle !== undefined) {
      testStage(options, 'file_close');
      try {
        await handle.close();
      }
      catch (error) { if (!unsupported.has((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
  }
}

async function writeAndVerify(handle: Awaited<ReturnType<typeof open>>, target: string, root: string, bytes: Uint8Array, options: DaemonFileOptions, expected?: FileIdentity, verifyAclBeforeWrite = false): Promise<FileIdentity> {
  const platform = currentPlatform(options);
  testStage(options, 'descriptor_stat');
  const before = await handle.stat();
  assertDescriptor(before, expected, platform);
  if (platform !== 'win32') await handle.chmod(0o600);
  testStage(options, 'descriptor_stat');
  const secured = await handle.stat();
  assertDescriptor(secured, expected, platform);
  if (platform !== 'win32' && mode(secured) !== 0o600) fail('permissions', 'temporary metadata file is not 0600');
  await verifyLstat(target, identity(secured), platform, 0o600, options);
  if (verifyAclBeforeWrite && platform === 'win32') {
    await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file', options);
  }
  testStage(options, 'file_write');
  await handle.writeFile(bytes);
  testStage(options, 'file_sync');
  await handle.sync();
  testStage(options, 'descriptor_stat');
  const after = await handle.stat();
  assertDescriptor(after, identity(secured), platform);
  if (after.size !== bytes.byteLength || (platform !== 'win32' && mode(after) !== 0o600)) fail('race', 'temporary metadata file changed while writing');
  await verifyLstat(target, identity(after), platform, 0o600, options);
  if (platform === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file', options);
  return identity(after);
}

async function renameAtomically(temporary: string, target: string, options: DaemonFileOptions): Promise<void> {
  const platform = currentPlatform(options);
  const replace = options.testHooks?.rename ?? rename;
  for (let attempt = 0; ; attempt += 1) {
    try {
      await replace(temporary, target);
      return;
    } catch (error) {
      if (platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM' || attempt >= WINDOWS_RENAME_RETRIES) {
        throw error;
      }
      const sleep = options.testHooks?.sleep
        ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
      await sleep(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

async function atomicReplace(target: string, root: string, bytes: Uint8Array, options: DaemonFileOptions): Promise<void> {
  const temporary = join(root, `.${METADATA_FILENAME}.${process.pid}.${randomBytes(16).toString('hex')}.tmp`);
  const handle = await open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let temporaryIdentity: FileIdentity | undefined;
  try {
    testStage(options, 'descriptor_stat');
    const opened = await handle.stat();
    assertDescriptor(opened, undefined, currentPlatform(options));
    temporaryIdentity = identity(opened);
    const writtenIdentity = await writeAndVerify(handle, temporary, root, bytes, options);
    if (!sameIdentity(temporaryIdentity, writtenIdentity)) fail('race', 'temporary metadata identity changed');
    testStage(options, 'file_close');
    await handle.close();
    await renameAtomically(temporary, target, options);
    await verifyLstat(target, temporaryIdentity, currentPlatform(options), 0o600, options);
    if (currentPlatform(options) === 'win32') await ensureWindowsAcl(target, options.windowsAcl ?? defaultWindowsAclAdapter(), 'file', options);
    await fsyncDirectory(root, currentPlatform(options), options);
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
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600, options);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options), options);
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
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600, options);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options), options);
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
  await verifyLstat(second.target, second.identity, currentPlatform(options), 0o600, options);
  await unlink(second.target);
  await fsyncDirectory(second.root, currentPlatform(options), options);
  return true;
}

export async function createLaunchingDaemonMetadataFile(path: string, metadata: DaemonMetadataV1, options: DaemonFileOptions): Promise<void> {
  if (metadata.state !== 'launching') fail('state', 'launch metadata must be launching');
  const safe = await secureTarget(path, options, false);
  const bytes = new TextEncoder().encode(encodeDaemonMetadataV1(metadata));
  testStage(options, 'create_open');
  const handle = await open(safe.target, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
  let createdIdentity: FileIdentity | undefined;
  try {
    testStage(options, 'descriptor_stat');
    const opened = await handle.stat();
    assertDescriptor(opened, undefined, currentPlatform(options));
    createdIdentity = identity(opened);
    await writeAndVerify(handle, safe.target, safe.root, bytes, options, createdIdentity, true);
    testStage(options, 'file_close');
    await handle.close();
    await fsyncDirectory(safe.root, currentPlatform(options), options);
  } catch (error) {
    try { await handle.close(); } catch { /* best effort */ }
    if (createdIdentity !== undefined) await removeOwnedFile(safe.target, createdIdentity);
    throw error;
  }
}
