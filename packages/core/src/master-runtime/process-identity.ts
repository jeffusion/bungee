import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';
import { posix, win32 } from 'node:path';

const PROBE_TIMEOUT_MS = 5_000;
const EXEC_OPTIONS = { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024, windowsHide: true };
const PS_OPTIONS = { ...EXEC_OPTIONS, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
const MARKER_PREFIX = '--bungee-process-identity=';
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOWS_MISSING_EXIT = 3;

export type ExecFileFn = (file: string, args: readonly string[], options: object) => Promise<{ stdout: string | Buffer }>;
export type ReadFileFn = (path: string, encoding?: BufferEncoding) => Promise<string | Buffer>;
export type RealpathFn = (path: string) => Promise<string>;
export type ProcessLiveness = 'alive' | 'dead' | 'unknown';
export type LivenessFn = (pid: number) => Promise<ProcessLiveness>;

export type CapturedProcessIdentity = Readonly<{
  readonly pid: number;
  readonly startToken: string;
  readonly executable: string;
  readonly processInstanceId: string;
}>;

export type ProcessIdentityProbe = 'exact' | 'dead' | 'mismatch' | 'unknown';

export type ProcessIdentityDeps = Readonly<{
  readonly platform?: NodeJS.Platform;
  readonly execFile?: ExecFileFn;
  readonly readFile?: ReadFileFn;
  readonly realpath?: RealpathFn;
  readonly liveness?: LivenessFn;
  /** Resolves the Windows PowerShell executable; injectable so units never touch the host. */
  readonly windowsPowerShell?: () => string;
}>;

export class ProcessIdentityMissingError extends Error {
  readonly name = 'ProcessIdentityMissingError';
  readonly code = 'process_identity_missing';
  constructor(pid: number) { super(`target process ${pid} is missing`); }
}

export class ProcessIdentityUnavailableError extends Error {
  readonly name = 'ProcessIdentityUnavailableError';
  readonly code = 'process_identity_unavailable';
  constructor(message: string) { super(message); }
}

type ProcessSample = Readonly<{
  readonly pid: number;
  readonly startToken: string;
  readonly executable: string;
  readonly argv: readonly string[];
}>;

const defaultExecFile = promisify(nodeExecFile) as unknown as ExecFileFn;
const defaultReadFile: ReadFileFn = async (path, encoding) => readFile(path, encoding ?? 'utf8');
const defaultRealpath: RealpathFn = async (path) => realpath(path);
const defaultLiveness: LivenessFn = async (pid) => {
  try { process.kill(pid, 0); return 'alive'; }
  catch (error) { return errorCode(error) === 'ESRCH' ? 'dead' : 'unknown'; }
};

function missing(pid: number): ProcessIdentityMissingError { return new ProcessIdentityMissingError(pid); }
function unavailable(message: string): ProcessIdentityUnavailableError { return new ProcessIdentityUnavailableError(message); }
function errorCode(error: unknown): unknown { return (error as { readonly code?: unknown } | null | undefined)?.code; }

export function canonicalExecutable(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = (platform === 'win32' ? win32.normalize(value) : posix.normalize(value)).replaceAll('\\', '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function parseCommandLine(value: string): string[] {
  return value.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g)?.map((part) =>
    part.length > 1 && ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")))
      ? part.slice(1, -1) : part) ?? [];
}

function markerMatches(argv: readonly string[], processInstanceId: string): boolean {
  const marker = `${MARKER_PREFIX}${processInstanceId}`;
  return LOWERCASE_UUID.test(processInstanceId)
    && argv.filter((argument) => argument === marker).length === 1
    && argv.every((argument) => !argument.startsWith(MARKER_PREFIX) || argument === marker);
}

// /proc/PID/stat: "pid (comm) state ..." — comm may contain spaces/parens, so fields are
// counted after the last ')'. fields[0] is state (field 3), so starttime (field 22) is fields[19].
function parseLinuxStat(value: string): { state: string; startToken: string } {
  const end = value.lastIndexOf(')');
  const fields = end < 0 ? [] : value.slice(end + 2).trim().split(/\s+/);
  const state = fields[0];
  const startToken = fields[19];
  if (!state || !startToken) throw unavailable('process stat record was malformed');
  return { state, startToken };
}

async function linuxSnapshot(pid: number, deps: ProcessIdentityDeps): Promise<ProcessSample> {
  const read = deps.readFile ?? defaultReadFile;
  const resolve = deps.realpath ?? defaultRealpath;
  const readProc = async (name: string): Promise<string> => {
    try { return String(await read(`/proc/${pid}/${name}`, 'utf8')); }
    catch (error) {
      if (errorCode(error) === 'ENOENT') throw missing(pid);
      throw unavailable(`process record /proc/${pid}/${name} could not be read`);
    }
  };
  const stat = parseLinuxStat(await readProc('stat'));
  if (stat.state === 'Z') throw missing(pid);
  const argv = (await readProc('cmdline')).split('\0').filter((part) => part.length > 0);
  let executable: string;
  try { executable = await resolve(`/proc/${pid}/exe`); }
  catch (error) {
    if (errorCode(error) === 'ENOENT') {
      // /proc/PID/exe can disappear while the process still exists (e.g. setuid binaries
      // hide it). Only report the process as missing when its stat entry is gone too.
      let statExists = false;
      let statError: unknown;
      try { await read(`/proc/${pid}/stat`, 'utf8'); statExists = true; }
      catch (caught) { statError = caught; }
      if (statExists) throw unavailable('process executable could not be resolved');
      if (errorCode(statError) === 'ENOENT') throw missing(pid);
      throw unavailable('process executable could not be resolved');
    }
    throw unavailable('process executable could not be resolved');
  }
  executable = executable.endsWith(' (deleted)') ? executable.slice(0, -' (deleted)'.length) : executable;
  return { pid, startToken: stat.startToken, executable, argv };
}

async function linuxSample(pid: number, deps: ProcessIdentityDeps): Promise<ProcessSample> {
  const first = await linuxSnapshot(pid, deps);
  const second = await linuxSnapshot(pid, deps);
  const consistent = first.startToken === second.startToken && first.executable === second.executable
    && first.argv.length === second.argv.length && first.argv.every((part, index) => part === second.argv[index]);
  if (!consistent) throw unavailable('process identity samples did not converge');
  return first;
}

/**
 * PowerShell 7 (pwsh) cold-starts far below Windows PowerShell 5.1; a replacement master
 * captures three processes in sequence, so the legacy shell's CIM cold start blows the
 * per-probe budget. Prefers pwsh when installed and falls back to powershell.exe.
 */
export function resolveWindowsPowerShell(
  programFiles: string | undefined,
  exists: (path: string) => boolean = existsSync,
): string {
  if (programFiles !== undefined) {
    const pwsh = win32.join(programFiles, 'PowerShell', '7', 'pwsh.exe');
    if (exists(pwsh)) return pwsh;
  }
  return 'powershell.exe';
}

const defaultWindowsPowerShell = (): string => resolveWindowsPowerShell(process.env.ProgramFiles);

async function windowsSample(pid: number, deps: ProcessIdentityDeps): Promise<ProcessSample> {
  const run = deps.execFile ?? defaultExecFile;
  // ManagementObjectSearcher with a single-PID WQL WHERE clause: no CIM cmdlet machinery
  // and never a full-process scan; the missing process exits with WINDOWS_MISSING_EXIT.
  const script = `$ErrorActionPreference='Stop'; $s=[System.Management.ManagementObjectSearcher]::new('SELECT ProcessId,CreationDate,ExecutablePath,CommandLine FROM Win32_Process WHERE ProcessId=${pid}'); $p=$s.Get() | Select-Object -First 1; if($null -eq $p){exit ${WINDOWS_MISSING_EXIT}}; $p | Select-Object ProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
  let stdout: string | Buffer;
  try { ({ stdout } = await run((deps.windowsPowerShell ?? defaultWindowsPowerShell)(), ['-NoProfile', '-NonInteractive', '-Command', script], EXEC_OPTIONS)); }
  catch (error) {
    const code = errorCode(error);
    if (code === WINDOWS_MISSING_EXIT || code === String(WINDOWS_MISSING_EXIT)) throw missing(pid);
    throw unavailable('process query failed');
  }
  let record: unknown;
  try { record = JSON.parse(stdout.toString()); }
  catch { throw unavailable('process record was malformed'); }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) throw unavailable('process record was malformed');
  const { ProcessId, CreationDate, ExecutablePath, CommandLine } = record as Readonly<Record<string, unknown>>;
  if (typeof ProcessId !== 'number' || !Number.isSafeInteger(ProcessId)
    || typeof CreationDate !== 'string' || typeof ExecutablePath !== 'string' || typeof CommandLine !== 'string') {
    throw unavailable('process record was incomplete');
  }
  if (ProcessId !== pid) throw unavailable('process record did not match the requested pid');
  return { pid: ProcessId, startToken: CreationDate, executable: ExecutablePath, argv: parseCommandLine(CommandLine) };
}

// macOS hardened runners do not expose the binary argv API, so identity comes from
// /bin/ps for a single pid in the C locale — fixed-width lstart at line start is the
// start token, the command remainder restores marker argv by whitespace splitting (an
// argv element containing whitespace can therefore never match the marker: fail closed).
const DARWIN_PS_LINE = /^(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/;
const DARWIN_PS = '/bin/ps';
const DARWIN_LSOF = '/usr/sbin/lsof';

/**
 * The main executable is the single lsof txt entry whose canonical basename equals the
 * kernel command name reported by `ps -o comm=` (comm may be a bare name or a full path).
 * Zero or multiple matches fail closed; dyld/dylib images fall out naturally because
 * their basenames differ, and no ordering is assumed.
 */
function matchMainExecutable(names: readonly string[], comm: string): string | null {
  if (comm.length === 0 || comm.includes('\n')) return null;
  const wanted = posix.basename(comm);
  const candidates = names.filter((path) => posix.basename(path) === wanted);
  return candidates.length === 1 ? candidates[0] : null;
}

async function darwinSample(pid: number, deps: ProcessIdentityDeps): Promise<ProcessSample> {
  const run = deps.execFile ?? defaultExecFile;
  // A failed query is only "dead" when liveness positively confirms it; otherwise unknown.
  const confirmDead = async (): Promise<boolean> => {
    try { return (await (deps.liveness ?? defaultLiveness)(pid)) === 'dead'; }
    catch { return false; }
  };
  let psStdout: string | Buffer;
  try {
    ({ stdout: psStdout } = await run(DARWIN_PS, ['-ww', '-p', String(pid), '-o', 'lstart=', '-o', 'command='], PS_OPTIONS));
  } catch {
    if (await confirmDead()) throw missing(pid);
    throw unavailable('process query failed');
  }
  const line = psStdout.toString().trimEnd();
  const match = DARWIN_PS_LINE.exec(line);
  if (match === null) {
    if (line.length === 0 && await confirmDead()) throw missing(pid);
    throw unavailable('process start token was malformed');
  }
  // The kernel command name disambiguates the lsof txt list; both are single-pid, C-locale.
  let commStdout: string | Buffer;
  try {
    ({ stdout: commStdout } = await run(DARWIN_PS, ['-ww', '-p', String(pid), '-o', 'comm='], PS_OPTIONS));
  } catch {
    if (await confirmDead()) throw missing(pid);
    throw unavailable('process query failed');
  }
  const comm = commStdout.toString().trim();
  let lsofStdout: string | Buffer;
  try {
    ({ stdout: lsofStdout } = await run(DARWIN_LSOF, ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], PS_OPTIONS));
  } catch {
    if (await confirmDead()) throw missing(pid);
    throw unavailable('process query failed');
  }
  const names = lsofStdout.toString().split('\n')
    .filter((row) => row.startsWith('n') && row.length > 1)
    .map((row) => row.slice(1));
  const executable = matchMainExecutable(names, comm);
  if (executable === null) throw unavailable('main executable could not be identified');
  return {
    pid,
    startToken: match[1].replace(/\s+/g, ' '),
    executable,
    argv: match[2].trim().split(/\s+/).filter((part) => part.length > 0),
  };
}

async function sampleProcess(pid: number, deps: ProcessIdentityDeps): Promise<ProcessSample> {
  const platform = deps.platform ?? process.platform;
  const work = platform === 'linux' ? linuxSample(pid, deps)
    : platform === 'win32' ? windowsSample(pid, deps)
    : platform === 'darwin' ? darwinSample(pid, deps)
    : Promise.reject(unavailable('process identity sampling is unsupported on this platform'));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(unavailable('process identity sampling timed out')), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export async function captureProcessIdentity(pid: number, processInstanceId: string, deps: ProcessIdentityDeps = {}): Promise<CapturedProcessIdentity> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || !LOWERCASE_UUID.test(processInstanceId)) {
    throw new TypeError('invalid process identity request');
  }
  const sample = await sampleProcess(pid, deps);
  if (sample.pid !== pid || !markerMatches(sample.argv, processInstanceId)) {
    throw unavailable('captured process does not carry the requested identity marker');
  }
  return { pid: sample.pid, startToken: sample.startToken, executable: sample.executable, processInstanceId };
}

export async function probeProcessIdentity(expected: CapturedProcessIdentity, deps: ProcessIdentityDeps = {}): Promise<ProcessIdentityProbe> {
  if (!Number.isSafeInteger(expected.pid) || expected.pid <= 0 || !LOWERCASE_UUID.test(expected.processInstanceId)) return 'mismatch';
  try {
    const actual = await sampleProcess(expected.pid, deps);
    const platform = deps.platform ?? process.platform;
    if (actual.pid !== expected.pid || actual.startToken !== expected.startToken
      || canonicalExecutable(actual.executable, platform) !== canonicalExecutable(expected.executable, platform)
      || !markerMatches(actual.argv, expected.processInstanceId)) return 'mismatch';
    return 'exact';
  } catch (error) {
    if (error instanceof ProcessIdentityMissingError) return 'dead';
    return 'unknown';
  }
}
