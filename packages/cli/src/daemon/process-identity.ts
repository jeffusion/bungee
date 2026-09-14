import { lstat, realpath } from 'node:fs/promises';
import { readdir, readFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { posix, win32 } from 'node:path';

const execFile = promisify(nodeExecFile);
const PROBE_TIMEOUT_MS = 5_000;
const EXEC_OPTIONS = { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024, windowsHide: true };
const PS_OPTIONS = { ...EXEC_OPTIONS, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
const MARKER_PREFIX = '--bungee-daemon-boot=';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const TARGET_PROCESS_MISSING_SENTINEL = '__BUNGEE_TARGET_PROCESS_MISSING__';

export type ProcessIdentityProbeOptions = Readonly<{
  readonly platform?: NodeJS.Platform;
  readonly execFile?: (file: string, args: readonly string[], options: object) => Promise<{ stdout: string | Buffer }>;
  readonly readFile?: typeof readFile;
  readonly realpath?: typeof realpath;
  readonly readdir?: typeof readdir;
  readonly liveness?: (pid: number) => Promise<ProcessAliveProbe>;
}>;

function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('process probe timed out')), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export type ProcessIdentity = Readonly<{ executable: string; entrypoint: string | null }>;
export type ProcessProbe = 'exact' | 'mismatch' | 'dead' | 'unknown';
export type MarkerProbe = 'found' | 'none' | 'unknown';
export type ProcessUserProbe = 'same' | 'different' | 'unknown';
export type ProcessAliveProbe = 'alive' | 'dead' | 'unknown';

export class TargetProcessMissingError extends Error {
  readonly name = 'TargetProcessMissingError';
  readonly code = 'target_process_missing';
}

class ProcessIdentityUnavailableError extends Error {
  readonly argv: readonly string[];
  constructor(argv: readonly string[], message: string) { super(message); this.name = 'ProcessIdentityUnavailableError'; this.argv = argv; }
}

export function canonicalProcessPath(value: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = (platform === 'win32' ? win32.normalize(value) : posix.normalize(value)).replaceAll('\\', '/');
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}

export function parseCommandLine(value: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') {
    // ps output is already argv-like for the supported Unix launch forms.
    return value.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g)?.map((part) =>
      part.length > 1 && ((part.startsWith('"') && part.endsWith('"')) || (part.startsWith("'") && part.endsWith("'")))
        ? part.slice(1, -1) : part) ?? [];
  }
  const result: string[] = [];
  let current = '';
  let quote = '';
  let backslashes = 0;
  let started = false;
  const push = () => { if (started || current.length > 0) result.push(current); current = ''; started = false; };
  for (const char of value) {
    if (char === '\\') { backslashes += 1; continue; }
    if (char === '"') {
      current += '\\'.repeat(Math.floor(backslashes / 2));
      if (backslashes % 2 === 1) current += '"';
      else quote = quote === '"' ? '' : quote === '' ? '"' : quote;
      backslashes = 0; started = true; continue;
    }
    current += '\\'.repeat(backslashes); backslashes = 0;
    if (quote === '' && /\s/.test(char)) push();
    else { current += char; started = true; }
  }
  current += '\\'.repeat(backslashes);
  push();
  return result;
}

export function exactBootMarker(argv: readonly string[], bootNonce: string): boolean {
  return argv.filter((argument) => argument === `${MARKER_PREFIX}${bootNonce}`).length === 1
    && argv.every((argument) => !argument.startsWith(MARKER_PREFIX) || argument === `${MARKER_PREFIX}${bootNonce}`)
    && UUID.test(bootNonce);
}

export function parseLinuxProcStatState(value: string): string | null {
  const end = value.lastIndexOf(')');
  if (end < 0 || value.length <= end + 2) return null;
  return value.slice(end + 2).trim().split(/\s+/)[0] ?? null;
}

function expectedMatches(actual: ProcessIdentity, expected: ProcessIdentity, platform: NodeJS.Platform): boolean {
  return canonicalProcessPath(actual.executable, platform) === canonicalProcessPath(expected.executable, platform)
    && (actual.entrypoint === null ? expected.entrypoint === null : expected.entrypoint !== null
      && canonicalProcessPath(actual.entrypoint, platform) === canonicalProcessPath(expected.entrypoint, platform));
}

function pidDirectory(pid: number): string { return `/proc/${pid}`; }

function parseLinuxStat(value: string): { readonly state: string } {
  const state = parseLinuxProcStatState(value);
  if (state === null) throw new Error('invalid /proc stat');
  return { state };
}

async function linuxProcess(pid: number, options: ProcessIdentityProbeOptions): Promise<{ identity: ProcessIdentity; argv: string[] }> {
  const read = options.readFile ?? readFile;
  const resolveRealpath = options.realpath ?? realpath;
  const procRead = async (path: string, encoding?: BufferEncoding): Promise<string | Buffer> => {
    try { return await read(path, encoding as any); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && path.startsWith(`${pidDirectory(pid)}/`)) {
        throw new TargetProcessMissingError(`target process ${pid} is missing`);
      }
      throw error;
    }
  };
  const stat = parseLinuxStat(await procRead(`${pidDirectory(pid)}/stat`, 'utf8') as string);
  if (stat.state === 'Z') throw new TargetProcessMissingError(`target process ${pid} is a zombie`);
  const command = await procRead(`${pidDirectory(pid)}/cmdline`);
  const argv = (command as Buffer).toString().split('\0').filter(Boolean);
  let executable: string;
  try { executable = await resolveRealpath(`${pidDirectory(pid)}/exe`); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new TargetProcessMissingError(`target process ${pid} is missing`);
    throw new ProcessIdentityUnavailableError(argv, 'Linux process executable could not be canonicalized');
  }
  executable = executable.endsWith(' (deleted)') ? executable.slice(0, -' (deleted)'.length) : executable;
  return { identity: { executable, entrypoint: argv[1]?.match(/\.(?:js|ts)$/i) ? argv[1] : null }, argv };
}

async function windowsProcess(pid: number, options: ProcessIdentityProbeOptions): Promise<{ identity: ProcessIdentity; argv: string[] }> {
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -eq $p){[Console]::Out.Write('${TARGET_PROCESS_MISSING_SENTINEL}'); exit 3}; $p | ConvertTo-Json -Compress`;
  let stdout: string | Buffer;
  try { ({ stdout } = await (options.execFile ?? execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], EXEC_OPTIONS)); }
  catch (error) {
    const code: unknown = (error as { readonly code?: unknown }).code;
    if (code === 3 || code === '3') throw new TargetProcessMissingError(`target process ${pid} is missing`);
    throw error;
  }
  const output = stdout.toString();
  if (output.trim() === TARGET_PROCESS_MISSING_SENTINEL) throw new TargetProcessMissingError(`target process ${pid} is missing`);
  const value = JSON.parse(output) as { ExecutablePath?: string; CommandLine?: string; CreationDate?: string };
  if (typeof value.CommandLine !== 'string') throw new Error('invalid CIM process');
  const argv = parseCommandLine(value.CommandLine, 'win32');
  return { identity: { executable: value.ExecutablePath ?? '', entrypoint: argv[1]?.match(/\.(?:js|ts)$/i) ? argv[1] : null }, argv };
}

async function psProcess(pid: number, options: ProcessIdentityProbeOptions, expected?: ProcessIdentity, bootNonce?: string): Promise<{ identity: ProcessIdentity; argv: string[] }> {
  let stdout: string | Buffer;
  try { ({ stdout } = await (options.execFile ?? execFile)('ps', ['-ww', '-p', String(pid), '-o', 'command='], PS_OPTIONS)); }
  catch (error) {
    const code: unknown = (error as { readonly code?: unknown }).code;
    if (code === 1 || code === '1') {
      const alive = await (options.liveness ?? ((target: number) => probeProcessAlive(target, { ...options, platform: 'darwin' })))(pid).catch(() => 'unknown' as const);
      if (alive === 'dead') throw new TargetProcessMissingError(`target process ${pid} is missing`);
    }
    throw error;
  }
  const line = stdout.toString().trim();
  if (line.length === 0) throw new TargetProcessMissingError(`target process ${pid} is missing`);
  const expectedPrefix = expected === undefined || bootNonce === undefined ? null
    : `${expected.executable}${expected.entrypoint === null ? '' : ` ${expected.entrypoint}`} --bungee-daemon-boot=${bootNonce}`;
  if (expected !== undefined && bootNonce !== undefined && expectedPrefix !== null && line === expectedPrefix) {
    return { identity: expected, argv: [expected.executable, ...(expected.entrypoint === null ? [] : [expected.entrypoint]), `--bungee-daemon-boot=${bootNonce}`] };
  }
  const argv = parseCommandLine(line, options.platform ?? process.platform);
  if (argv.length === 0) throw new Error('invalid ps process');
  let executable: string;
  try { executable = await (options.realpath ?? realpath)(argv[0]!); }
  catch (error) { throw new ProcessIdentityUnavailableError(argv, `process executable could not be canonicalized: ${String(error)}`); }
  return { identity: { executable, entrypoint: argv[1]?.match(/\.(?:js|ts)$/i) ? argv[1]! : null }, argv };
}

async function inspectProcess(pid: number, options: ProcessIdentityProbeOptions, expected: ProcessIdentity, bootNonce: string): Promise<{ identity: ProcessIdentity; argv: string[] }> {
  const platform = options.platform ?? process.platform;
  if (platform === 'linux') return linuxProcess(pid, options);
  if (platform === 'win32') return windowsProcess(pid, options);
  return psProcess(pid, options, expected, bootNonce);
}

export async function probeDaemonProcess(pid: number, expected: ProcessIdentity, bootNonce: string, options: ProcessIdentityProbeOptions = {}): Promise<ProcessProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'mismatch';
  try {
    const actual = await bounded(inspectProcess(pid, options, expected, bootNonce));
    if (!exactBootMarker(actual.argv, bootNonce)) return 'mismatch';
    if (!expectedMatches(actual.identity, expected, options.platform ?? process.platform)) return 'unknown';
    return 'exact';
  } catch (error) {
    if (error instanceof TargetProcessMissingError) return 'dead';
    if (error instanceof ProcessIdentityUnavailableError && !exactBootMarker(error.argv, bootNonce)) return 'mismatch';
    return 'unknown';
  }
}

export async function probeDaemonProcessUser(pid: number, options: ProcessIdentityProbeOptions = {}): Promise<ProcessUserProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'different';
  try {
    const platform = options.platform ?? process.platform;
    if (platform === 'linux') {
      const value = String(await (options.readFile ?? readFile)(`/proc/${pid}/status`, 'utf8'));
      const match = /^Uid:\s+(\d+)/m.exec(value);
      if (match === null || typeof process.getuid !== 'function') return 'unknown';
      return Number(match[1]) === process.getuid() ? 'same' : 'different';
    }
    if (platform !== 'win32') {
      const { stdout } = await (options.execFile ?? execFile)('ps', ['-p', String(pid), '-o', 'uid='], EXEC_OPTIONS);
      const uid = Number(stdout.toString().trim());
      if (!Number.isSafeInteger(uid) || typeof process.getuid !== 'function') return 'unknown';
      return uid === process.getuid() ? 'same' : 'different';
    }
    let stdout: string | Buffer;
    ({ stdout } = await (options.execFile ?? execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; if($null -eq $p){exit 3}; $o=Invoke-CimMethod -InputObject $p -MethodName GetOwner; if($null -eq $o){exit 4}; $a=New-Object System.Security.Principal.NTAccount($o.Domain,$o.User); $sid=$a.Translate([System.Security.Principal.SecurityIdentifier]).Value; $current=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; [Console]::Write(\"$sid|$current\")`,
    ], EXEC_OPTIONS));
    const [owner, current] = stdout.toString().trim().split('|');
    const sid = /^S-\d-\d+(?:-\d+)+$/i;
    return owner !== undefined && current !== undefined && sid.test(owner) && sid.test(current)
      ? owner.toLowerCase() === current.toLowerCase() ? 'same' : 'different' : 'unknown';
  } catch (error) {
    if (error instanceof TargetProcessMissingError) return 'different';
    return 'unknown';
  }
}

export async function probeProcessAlive(pid: number, options: ProcessIdentityProbeOptions = {}): Promise<ProcessAliveProbe> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'dead';
  if ((options.platform ?? process.platform) === 'linux') {
    try { await lstat(`/proc/${pid}`); return 'alive'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'dead' : 'unknown'; }
  }
  if ((options.platform ?? process.platform) !== 'win32') {
    try { process.kill(pid, 0); return 'alive'; }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'; }
  }
  try {
    await (options.execFile ?? execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { exit 0 } else { exit 3 }`], EXEC_OPTIONS);
    return 'alive';
  } catch (error) {
    const code: unknown = (error as { readonly code?: unknown }).code;
    if (code === 3 || code === '3') return 'dead';
    return 'unknown';
  }
}

export async function findExactDaemonProcess(bootNonce: string, options: ProcessIdentityProbeOptions = {}): Promise<MarkerProbe> {
  try {
    const platform = options.platform ?? process.platform;
    if (platform === 'linux') {
      const entries = await bounded((options.readdir ?? readdir)('/proc'));
      const pids = entries.filter((entry) => /^\d+$/.test(entry));
      const results = await bounded(Promise.all(pids.map(async (entry) => {
        try { return exactBootMarker((await linuxProcess(Number(entry), options)).argv, bootNonce); }
        catch (error) {
          if (error instanceof TargetProcessMissingError) return false;
          if (error instanceof ProcessIdentityUnavailableError && !exactBootMarker(error.argv, bootNonce)) return false;
          throw error;
        }
      })));
      return results.includes(true) ? 'found' : 'none';
    }
    if (platform === 'win32') {
      const script = 'Get-CimInstance Win32_Process | Select-Object CommandLine | ConvertTo-Json -Compress';
      const { stdout } = await (options.execFile ?? execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], EXEC_OPTIONS);
      const values = JSON.parse(stdout.toString()) as { CommandLine?: string } | Array<{ CommandLine?: string }>;
      const list = Array.isArray(values) ? values : [values];
      if (list.some((value) => typeof value.CommandLine !== 'string')) return 'unknown';
      return list.some((value) => typeof value.CommandLine === 'string' && exactBootMarker(parseCommandLine(value.CommandLine, 'win32'), bootNonce)) ? 'found' : 'none';
    }
    const { stdout } = await (options.execFile ?? execFile)('ps', ['-ww', '-axo', 'command='], EXEC_OPTIONS);
    return stdout.toString().split('\n').some((line: string) => exactBootMarker(parseCommandLine(line.trim(), platform), bootNonce)) ? 'found' : 'none';
  } catch { return 'unknown'; }
}
