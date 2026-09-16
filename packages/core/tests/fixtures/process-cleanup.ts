import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile, readlink, readdir } from 'node:fs/promises';
import { promisify } from 'node:util';

export type ProcessHandle = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: string | null;
  readonly kill?: (signal?: NodeJS.Signals) => void | boolean;
};

export type ProcessIdentitySnapshot = {
  readonly pid: number;
  readonly ppid: number;
  readonly startToken: string;
  readonly executable: string;
  readonly commandLine: string;
  readonly roleMarker?: string;
  readonly testMarker?: string;
};

export type ProcessOwnershipProof = ProcessIdentitySnapshot;

export type RegisteredProcessSnapshot = {
  readonly pid: number;
  readonly hasLiveHandle: boolean;
  readonly identity?: ProcessIdentitySnapshot;
  readonly role?: 'worker' | 'ingress';
  readonly ports?: readonly number[];
};

type ProcessRegistration = {
  readonly pid: number;
  readonly handle?: ProcessHandle;
  readonly identity?: ProcessIdentitySnapshot;
  readonly role?: 'worker' | 'ingress';
  readonly ports?: readonly number[];
};

type CleanupShutdown = () => Promise<void> | void;

export type ProcessCleanupOptions = {
  readonly expectGraceful: boolean;
  readonly shutdown?: CleanupShutdown;
  /** Observe ports/locks before emergency teardown starts. */
  readonly observeGraceful?: () => Promise<void> | void;
};

export type ProcessRegistryOptions = {
  readonly liveness?: (pid: number) => ProcessLiveness | Promise<ProcessLiveness>;
  readonly captureIdentity?: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
  /** Boolean adapter is intentionally test-only; production defaults to tri-state processLiveness. */
  readonly alive?: (pid: number) => boolean | Promise<boolean>;
  readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => unknown;
  readonly requireTestMarker?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly timing?: {
    readonly termWaitMs?: number;
    readonly killWaitMs?: number;
    readonly waitStepMs?: number;
  };
};

export type ExactProcessRegistration = {
  readonly identity: ProcessIdentitySnapshot;
  readonly role?: 'worker' | 'ingress';
  readonly ports?: readonly number[];
};

const WAIT_STEP_MS = 25;
export const PROCESS_PROBE_TIMEOUT_MS = 5_000;
const TERM_WAIT_MS = 1_500;
const KILL_WAIT_MS = 3_000;
const PROCESS_PROBE_MAX_BUFFER = 1024 * 1024;
const execFileAsync = promisify(execFile);
const MAC_PS_OPTIONS = {
  timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const, windowsHide: true,
  maxBuffer: PROCESS_PROBE_MAX_BUFFER, env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
};
const MAC_PS_ENV_OPTIONS = { ...MAC_PS_OPTIONS, maxBuffer: 64 * 1024 };
const owners = new Map<number, { readonly registry: ProcessRegistry; readonly identity?: ProcessIdentitySnapshot }>();
const portOwners = new Map<number, ProcessRegistry>();

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !('code' in error)) return undefined;
  return typeof error.code === 'string' || typeof error.code === 'number' ? String(error.code) : undefined;
}

function validPid(pid: number | undefined): pid is number {
  return pid !== undefined && Number.isSafeInteger(pid) && pid > 0;
}

function completeIdentity(identity: ProcessIdentitySnapshot, requireTestMarker: boolean): boolean {
  return validPid(identity.pid) && validPid(identity.ppid)
    && identity.startToken !== '' && identity.executable !== '' && identity.commandLine !== ''
    && (!requireTestMarker || identity.testMarker !== undefined);
}

class ProcessProbeTimeoutError extends Error {
  constructor(readonly pid?: number) {
    super(`process probe timed out${pid === undefined ? '' : ` for PID ${pid}`}`);
    this.name = 'ProcessProbeTimeoutError';
  }
}

async function withProbeTimeout<TResult>(operation: Promise<TResult>, pid?: number): Promise<TResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<TResult>((_, reject) => { timer = setTimeout(() => reject(new ProcessProbeTimeoutError(pid)), PROCESS_PROBE_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function parseLinuxProcessStartToken(stat: string): string | null {
  const closingParen = stat.lastIndexOf(')');
  if (closingParen < 0) return null;
  const fields = stat.slice(closingParen + 1).trim().split(/\s+/);
  return fields[19] ?? null;
}

export function windowsProcessIdentityCommand(pid: number): string {
  if (!validPid(pid)) throw new Error('process PID must be a positive integer');
  return windowsManagementObjectSearcherCommand(`ProcessId = ${pid}`);
}

const WINDOWS_PROCESS_PROJECTION = 'ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine';
export type WindowsQueryPhase = 'started' | 'wmi_query' | 'serialize' | null;

function windowsManagementObjectSearcherCommand(filter: string): string {
  return `$ErrorActionPreference = 'Stop'; $phase = 'started'; [Console]::Error.WriteLine('started'); [Console]::Error.Flush(); try { $phase = 'wmi_query'; [Console]::Error.WriteLine('wmi_query'); [Console]::Error.Flush(); $searcher = [System.Management.ManagementObjectSearcher]::new('root\\CIMV2', 'SELECT ${WINDOWS_PROCESS_PROJECTION} FROM Win32_Process WHERE ${filter}'); $rows = @($searcher.Get()); $phase = 'serialize'; [Console]::Error.WriteLine('serialize'); [Console]::Error.Flush(); @($rows | Select-Object ${WINDOWS_PROCESS_PROJECTION}) | ConvertTo-Json -Compress } catch { exit 1 }`;
}

export class WindowsQueryExecutionError extends Error {
  constructor(readonly lastPhase: WindowsQueryPhase, readonly queryCode: string | undefined) {
    super(`Windows process query failed last_phase=${lastPhase ?? 'none'}`);
    this.name = 'WindowsQueryExecutionError';
  }
}

export function windowsQueryPhase(stderr: unknown): WindowsQueryPhase {
  const text = typeof stderr === 'string' ? stderr : Buffer.isBuffer(stderr) ? stderr.toString() : '';
  const matches = [...text.matchAll(/^\s*(started|wmi_query|serialize)\s*$/gmu)];
  return (matches.at(-1)?.[1] as Exclude<WindowsQueryPhase, null> | undefined) ?? null;
}

function windowsQueryPhaseFromError(error: unknown): WindowsQueryPhase {
  if (!(error instanceof Error) || !('stderr' in error)) return null;
  return windowsQueryPhase((error as Error & { readonly stderr?: unknown }).stderr);
}

export function windowsQueryCode(error: unknown): string | undefined {
  const code = errorCode(error);
  if (code !== undefined) return code;
  if (error !== null && typeof error === 'object') {
    const record = error as { readonly killed?: unknown; readonly signal?: unknown; readonly code?: unknown };
    if (record.killed === true && record.signal === 'SIGKILL' && record.code == null) return 'ETIMEDOUT';
  }
  return undefined;
}

async function executeWindowsProcessQuery(command: string): Promise<string> {
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
    ], { timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: PROCESS_PROBE_MAX_BUFFER });
    return result.stdout.toString();
  } catch (error) {
    const queryCode = windowsQueryCode(error);
    throw new WindowsQueryExecutionError(windowsQueryPhaseFromError(error), queryCode);
  }
}

export type WindowsOwnedSnapshotDiagnostics = {
  readonly operation: 'owned_snapshot';
  readonly reason: 'query_timeout' | 'query_exit' | 'spawn_error' | 'parse_error' | 'incomplete' | 'missing' | 'root_mismatch';
  readonly last_phase: WindowsQueryPhase;
  readonly root_pid: number;
  readonly requested_count: number;
  readonly returned_count: number;
  readonly incomplete_count: number;
};

export class WindowsOwnedSnapshotError extends Error {
  constructor(readonly diagnostics: WindowsOwnedSnapshotDiagnostics) {
    super(Object.entries(diagnostics).map(([key, value]) => `${key}=${value}`).join(' '));
    this.name = 'WindowsOwnedSnapshotError';
  }
}

export function windowsOwnedProcessSnapshotCommand(rootPid: number, requestedPids: readonly number[] = []): string {
  if (!validPid(rootPid)) throw new Error('root PID must be a positive integer');
  if (requestedPids.some((pid) => !validPid(pid))) throw new Error('requested PID must be a positive integer');
  const pids = [...new Set(requestedPids)].filter((pid) => pid !== rootPid).sort((left, right) => left - right);
  const filter = [`ProcessId = ${rootPid}`, `ParentProcessId = ${rootPid}`, ...pids.map((pid) => `ProcessId = ${pid}`)].join(' OR ');
  return windowsManagementObjectSearcherCommand(`(${filter})`);
}

function windowsProcessIdentityRow(value: unknown): ProcessIdentitySnapshot | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const pid = Number(record.ProcessId);
  const ppid = Number(record.ParentProcessId);
  const startToken = typeof record.CreationDate === 'string' ? record.CreationDate : '';
  const executable = typeof record.ExecutablePath === 'string' ? record.ExecutablePath : '';
  const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine : '';
  if (!validPid(pid) || !validPid(ppid) || startToken === '' || executable === '' || commandLine === '') return null;
  return { pid, ppid, startToken, executable, commandLine };
}

export function parseWindowsOwnedProcessSnapshotOutput(
  output: string,
  rootPid: number,
  requestedPids: readonly number[] = [],
  expectedRoot?: ProcessIdentitySnapshot,
  requireRoot = true,
): readonly ProcessIdentitySnapshot[] {
  if (!validPid(rootPid)) throw new Error('root PID must be a positive integer');
  if (requestedPids.some((pid) => !validPid(pid))) throw new Error('requested PID must be a positive integer');
  const requested = [...new Set(requestedPids)].filter((pid) => pid !== rootPid);
  let parsed: unknown;
  let incompleteCount = 0;
  try { parsed = output.trim() === '' ? [] : JSON.parse(output.trim()); }
  catch { parsed = []; incompleteCount = 1; }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const identities: ProcessIdentitySnapshot[] = [];
  const requestedSet = new Set(requested);
  let unexpected = false;
  for (const row of rows) {
    const identity = windowsProcessIdentityRow(row);
    if (identity === null) incompleteCount += 1;
    else {
      identities.push(identity);
      if (!(identity.pid === rootPid || identity.ppid === rootPid || requestedSet.has(identity.pid))) unexpected = true;
    }
  }
  const diagnostics = (reason: WindowsOwnedSnapshotDiagnostics['reason'], lastPhase: WindowsQueryPhase = 'serialize'): WindowsOwnedSnapshotDiagnostics => ({
    operation: 'owned_snapshot', reason, last_phase: lastPhase, root_pid: rootPid, requested_count: requested.length,
    returned_count: rows.length, incomplete_count: incompleteCount,
  });
  const pids = new Set<number>();
  let duplicate = false;
  for (const { pid } of identities) {
    if (pids.has(pid)) duplicate = true;
    pids.add(pid);
  }
  const root = identities.filter(({ pid }) => pid === rootPid);
  const missing = requested.some((pid) => !identities.some((identity) => identity.pid === pid));
  if (incompleteCount > 0) throw new WindowsOwnedSnapshotError(diagnostics('incomplete'));
  if (duplicate || unexpected) throw new WindowsOwnedSnapshotError(diagnostics('parse_error'));
  if (missing || requireRoot && root.length !== 1) throw new WindowsOwnedSnapshotError(diagnostics('missing'));
  if (expectedRoot !== undefined && (root.length !== 1 || !processIdentityMatches(expectedRoot, root[0]!, 'win32'))) {
    throw new WindowsOwnedSnapshotError(diagnostics('root_mismatch'));
  }
  return identities;
}

export function parseWindowsProcessIdentityOutput(output: string): ProcessIdentitySnapshot | null {
  const text = output.trim();
  if (text === '') return null;
  let value: unknown;
  try { value = JSON.parse(text); } catch { return null; }
  if (value === null || typeof value !== 'object') return null;
  const record = (Array.isArray(value) ? value[0] : value) as Record<string, unknown> | undefined;
  if (record === undefined || record === null) return null;
  const pid = Number(record.ProcessId);
  const ppid = Number(record.ParentProcessId);
  const startToken = typeof record.CreationDate === 'string' ? record.CreationDate : '';
  const executable = typeof record.ExecutablePath === 'string' ? record.ExecutablePath : '';
  const commandLine = typeof record.CommandLine === 'string' ? record.CommandLine : '';
  if (!validPid(pid) || !validPid(ppid) || startToken === '' || executable === '' || commandLine === '') return null;
  return { pid, ppid, startToken, executable, commandLine };
}

export function parseMacProcessIdentityOutput(output: string, pid: number): ProcessIdentitySnapshot | null {
  if (!validPid(pid)) return null;
  const fields = output.trim().split(/\s+/);
  const ppid = Number(fields.shift());
  if (!validPid(ppid) || fields.length < 7) return null;
  const startToken = fields.splice(0, 5).join(' ');
  const executable = fields.shift();
  const commandLine = fields.join(' ');
  if (executable === undefined || commandLine === '') return null;
  return { pid, ppid, startToken, executable, commandLine };
}

export function parseMacProcessSnapshotOutput(output: string): readonly ProcessIdentitySnapshot[] {
  return output.split(/\r?\n/).flatMap((line) => {
    const fields = line.trim().split(/\s+/);
    const pid = Number(fields.shift());
    if (!validPid(pid)) return [];
    const parsed = parseMacProcessIdentityOutput(fields.join(' '), pid);
    return parsed === null ? [] : [parsed];
  });
}

export function macProcessIdentityArgs(pid: number): readonly string[] {
  if (!validPid(pid)) throw new Error('process PID must be a positive integer');
  return ['-ww', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args=', '-p', String(pid)];
}

export function macProcessSnapshotArgs(): readonly string[] {
  return ['-ww', '-axo', 'pid=', '-o', 'ppid=', '-o', 'lstart=', '-o', 'comm=', '-o', 'args='];
}

export function macProcessEnvironmentArgs(pid: number): readonly string[] {
  if (!validPid(pid)) throw new Error('process PID must be a positive integer');
  return ['-Eww', '-p', String(pid), '-o', 'args='];
}

function canonicalExecutable(executable: string, platform = process.platform): string {
  return platform === 'win32' ? executable.toLowerCase() : executable;
}

export function processIdentityMatches(expected: ProcessIdentitySnapshot, actual: ProcessIdentitySnapshot, platform = process.platform): boolean {
  return expected.pid === actual.pid
    && expected.startToken === actual.startToken
    && canonicalExecutable(expected.executable, platform) === canonicalExecutable(actual.executable, platform)
    && expected.commandLine === actual.commandLine
    && (platform === 'win32' || (expected.roleMarker === actual.roleMarker && expected.testMarker === actual.testMarker));
}

export class ProcessSurvivorsError extends Error {
  constructor(readonly survivors: readonly number[], readonly phase = 'wait') {
    super(`${phase} processes remained alive: ${survivors.join(',')}`);
    this.name = 'ProcessSurvivorsError';
  }
}

export type ProcessCleanupEvidencePhase = 'sigterm_verify' | 'sigterm_signal' | 'sigterm_wait'
  | 'sigkill_verify' | 'sigkill_signal' | 'sigkill_wait' | 'final_verify';
export type ProcessCleanupEvidenceOutcome = 'probe_error' | 'identity_unknown' | 'identity_mismatch' | 'signal_error' | 'survivor';
export type ProcessCleanupEvidenceSignal = 'none' | 'SIGTERM' | 'SIGKILL';
export type ProcessCleanupEvidenceErrorCode = 'ESRCH' | 'EPERM' | 'ETIMEDOUT' | 'UNKNOWN';
export type ProcessCleanupEvidenceRole = 'root' | 'worker' | 'ingress' | 'child';
export type ProcessCleanupEvidenceEvent = Readonly<{
  phase: ProcessCleanupEvidencePhase;
  pid: number;
  role: ProcessCleanupEvidenceRole;
  outcome: ProcessCleanupEvidenceOutcome;
  signal: ProcessCleanupEvidenceSignal;
  error_code: ProcessCleanupEvidenceErrorCode;
  has_handle: boolean;
  identity_present: boolean;
  handle_exit_code: number | null;
  handle_signal_code: NodeJS.Signals | null;
}>;

const LEGAL_SIGNAL_CODES = new Set<NodeJS.Signals>([
  'SIGABRT', 'SIGALRM', 'SIGBUS', 'SIGCHLD', 'SIGCONT', 'SIGFPE', 'SIGHUP', 'SIGILL', 'SIGINT', 'SIGIO',
  'SIGIOT', 'SIGKILL', 'SIGPIPE', 'SIGPOLL', 'SIGPROF', 'SIGPWR', 'SIGQUIT', 'SIGSEGV', 'SIGSTKFLT',
  'SIGSTOP', 'SIGSYS', 'SIGTERM', 'SIGTRAP', 'SIGTSTP', 'SIGTTIN', 'SIGTTOU', 'SIGURG', 'SIGUSR1',
  'SIGUSR2', 'SIGVTALRM', 'SIGXCPU', 'SIGXFSZ',
]);

function cleanupRole(registration: ProcessRegistration): ProcessCleanupEvidenceRole {
  return registration.role ?? (registration.handle === undefined ? 'child' : 'root');
}

function cleanupErrorCode(error: unknown): ProcessCleanupEvidenceErrorCode {
  const code = errorCode(error);
  if (code === 'ESRCH' || code === 'EPERM' || code === 'ETIMEDOUT') return code;
  if (error instanceof ProcessProbeTimeoutError) return 'ETIMEDOUT';
  return 'UNKNOWN';
}

function cleanupHandleExitCode(handle: ProcessHandle | undefined): number | null {
  return handle !== undefined && Number.isInteger(handle.exitCode) ? handle.exitCode! : null;
}

function cleanupHandleSignalCode(handle: ProcessHandle | undefined): NodeJS.Signals | null {
  return handle !== undefined && typeof handle.signalCode === 'string' && LEGAL_SIGNAL_CODES.has(handle.signalCode as NodeJS.Signals)
    ? handle.signalCode as NodeJS.Signals : null;
}

class ProcessCleanupEvidenceRecorder {
  private readonly events: ProcessCleanupEvidenceEvent[] = [];

  add(
    registration: ProcessRegistration,
    phase: ProcessCleanupEvidencePhase,
    outcome: ProcessCleanupEvidenceOutcome,
    signal: ProcessCleanupEvidenceSignal,
    error?: unknown,
  ): void {
    if (this.events.length >= 8) return;
    this.events.push(Object.freeze({
      phase, pid: registration.pid, role: cleanupRole(registration), outcome, signal,
      error_code: cleanupErrorCode(error), has_handle: registration.handle !== undefined,
      identity_present: registration.identity !== undefined,
      handle_exit_code: cleanupHandleExitCode(registration.handle),
      handle_signal_code: cleanupHandleSignalCode(registration.handle),
    }));
  }

  snapshot(): readonly ProcessCleanupEvidenceEvent[] {
    return Object.freeze([...this.events]);
  }
}

export type ProcessCleanupAggregateError = AggregateError & Readonly<{
  process_cleanup_evidence: readonly ProcessCleanupEvidenceEvent[];
  entry_count: number;
  root_count: number;
  worker_count: number;
  ingress_count: number;
  child_count: number;
}>;

function attachProcessCleanupEvidence(
  error: AggregateError,
  registrations: readonly ProcessRegistration[],
  evidence: ProcessCleanupEvidenceRecorder,
): ProcessCleanupAggregateError {
  const count = (role: ProcessCleanupEvidenceRole): number => registrations.filter((registration) => cleanupRole(registration) === role).length;
  Object.defineProperties(error, {
    process_cleanup_evidence: { value: evidence.snapshot(), enumerable: true },
    entry_count: { value: registrations.length, enumerable: true },
    root_count: { value: count('root'), enumerable: true },
    worker_count: { value: count('worker'), enumerable: true },
    ingress_count: { value: count('ingress'), enumerable: true },
    child_count: { value: count('child'), enumerable: true },
  });
  return error as ProcessCleanupAggregateError;
}

export type ProcessLiveness = 'alive' | 'terminal' | 'absent' | 'unknown';

export function processLiveness(pid: number): ProcessLiveness {
  try {
    process.kill(pid, 0);
    if (process.platform !== 'linux') return 'alive';
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const state = stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3);
      if (state === 'Z' || state === 'X' || state === 'x') return 'terminal';
      if (state === '') return 'unknown';
      return 'alive';
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return 'absent';
      return 'unknown';
    }
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return 'absent';
    return 'unknown';
  }
}

export function processAlive(pid: number): boolean {
  const state = processLiveness(pid);
  if (state === 'unknown') throw new Error(`process liveness is unknown for PID ${pid}`);
  return state === 'alive';
}

export type LinuxIdentityReaders = {
  readonly readFile: typeof readFile;
  readonly readlink: typeof readlink;
};

async function readLinuxProcessIdentitySample(
  pid: number,
  readers: LinuxIdentityReaders = { readFile, readlink },
): Promise<ProcessIdentitySnapshot | null> {
  try {
    const [stat, executable, cmdline, environ] = await Promise.all([
      readers.readFile(`/proc/${pid}/stat`, 'utf8'),
      readers.readlink(`/proc/${pid}/exe`),
      readers.readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readers.readFile(`/proc/${pid}/environ`, 'utf8'),
    ]);
    const startToken = parseLinuxProcessStartToken(stat);
    const statFields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
    const ppid = Number(statFields[1]);
    const commandLine = cmdline.replaceAll('\0', ' ').trim();
    if (startToken === null || !validPid(ppid) || executable === '' || commandLine === '') return null;
    const roleMarker = environ.split('\0').find((entry) => entry.startsWith('BUNGEE_ROLE='))?.slice('BUNGEE_ROLE='.length);
    const testMarker = environ.split('\0').find((entry) => entry.startsWith('BUNGEE_TEST_PROCESS_MARKER='))?.slice('BUNGEE_TEST_PROCESS_MARKER='.length);
    return { pid, ppid, startToken, executable, commandLine,
      ...(roleMarker === undefined ? {} : { roleMarker }), ...(testMarker === undefined ? {} : { testMarker }) };
  } catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM'].includes(errorCode(error) ?? '')) return null;
    throw error;
  }
}

export async function captureLinuxProcessIdentity(
  pid: number,
  readers: LinuxIdentityReaders = { readFile, readlink },
): Promise<ProcessIdentitySnapshot | null> {
  if (!validPid(pid)) return null;
  const first = await readLinuxProcessIdentitySample(pid, readers);
  if (first === null) return null;
  const second = await readLinuxProcessIdentitySample(pid, readers);
  if (second === null || JSON.stringify(first) !== JSON.stringify(second)) return null;
  return first;
}

type MacExecFile = (file: string, args: readonly string[], options: object) => Promise<{
  readonly stdout: string | Buffer;
  readonly stderr: string | Buffer;
}>;

function emptyErrorOutput(error: unknown, field: 'stdout' | 'stderr'): boolean {
  if (!(error instanceof Error) || !Object.prototype.hasOwnProperty.call(error, field)) return false;
  const value = (error as Error & Record<string, unknown>)[field];
  return (typeof value === 'string' && value.length === 0) || (Buffer.isBuffer(value) && value.length === 0);
}

export async function captureMacProcessIdentity(
  pid: number,
  execute: MacExecFile = execFileAsync as unknown as MacExecFile,
): Promise<ProcessIdentitySnapshot | null> {
  if (!validPid(pid)) return null;
  try {
    const result = await execute('ps', macProcessIdentityArgs(pid), MAC_PS_OPTIONS);
    const parsed = parseMacProcessIdentityOutput(result.stdout.toString(), pid);
    if (parsed === null) throw new Error(`macOS process identity output could not be parsed for PID ${pid}`);
    return parsed;
  } catch (error) {
    if (errorCode(error) === '1' && emptyErrorOutput(error, 'stdout') && emptyErrorOutput(error, 'stderr')) return null;
    throw error;
  }
}

export type MacProcessEnvironmentResult = {
  readonly containsForbidden: boolean;
  readonly matchedIndex: number;
  readonly summary: 'clean' | 'forbidden';
};

export async function captureMacProcessEnvironment(
  pid: number,
  forbiddenNeedles: readonly string[],
): Promise<MacProcessEnvironmentResult> {
  if (!validPid(pid)) throw new Error('process PID must be a positive integer');
  if (forbiddenNeedles.some((needle) => needle.length === 0)) throw new Error('forbidden environment needles must be non-empty');
  try {
    const result = await execFileAsync('ps', macProcessEnvironmentArgs(pid), MAC_PS_ENV_OPTIONS);
    const matchedIndex = forbiddenNeedles.findIndex((needle) => result.stdout.toString().includes(needle));
    return {
      containsForbidden: matchedIndex >= 0,
      matchedIndex,
      summary: matchedIndex >= 0 ? 'forbidden' : 'clean',
    };
  } catch (error) {
    throw new Error(`macOS environment probe failed for PID ${pid} exit=${errorCode(error) ?? 'unknown'}`);
  }
}

export async function captureProcessIdentity(pid: number): Promise<ProcessIdentitySnapshot | null> {
  if (!validPid(pid)) return null;
  if (process.platform === 'win32') {
    try {
      const snapshot = parseWindowsOwnedProcessSnapshotOutput(await executeWindowsProcessQuery(windowsProcessIdentityCommand(pid)), pid, [], undefined, false);
      return snapshot.find((identity) => identity.pid === pid) ?? null;
    } catch (error) {
      if (error instanceof WindowsQueryExecutionError && ['ESRCH', 'ENOENT', 'EACCES'].includes(error.queryCode ?? '')) return null;
      throw error instanceof WindowsOwnedSnapshotError ? error : new Error(error instanceof Error ? error.message : 'Windows process identity query failed');
    }
  }
  if (process.platform === 'linux') return withProbeTimeout(captureLinuxProcessIdentity(pid), pid);
  return withProbeTimeout(captureMacProcessIdentity(pid), pid);
}

export async function captureProcessSnapshot(): Promise<readonly ProcessIdentitySnapshot[]> {
  if (process.platform === 'win32') throw new Error('Windows process snapshot requires an owned root PID');
  return withProbeTimeout(captureProcessSnapshotUnbounded());
}

export async function captureOwnedProcessSnapshot(
  rootPid: number,
  requestedPids: readonly number[] = [],
  expectedRoot?: ProcessIdentitySnapshot,
  requireRoot = true,
): Promise<readonly ProcessIdentitySnapshot[]> {
  if (!validPid(rootPid)) throw new Error('root PID must be a positive integer');
  if (requestedPids.some((pid) => !validPid(pid))) throw new Error('requested PID must be a positive integer');
  if (process.platform !== 'win32') return (await captureProcessSnapshotUnbounded()).filter(({ pid }) => pid === rootPid || requestedPids.includes(pid));
  try {
    const output = await executeWindowsProcessQuery(windowsOwnedProcessSnapshotCommand(rootPid, requestedPids));
    return parseWindowsOwnedProcessSnapshotOutput(output, rootPid, requestedPids, expectedRoot, requireRoot);
  } catch (error) {
    const queryCode = error instanceof WindowsQueryExecutionError ? error.queryCode : errorCode(error);
    if (error instanceof WindowsOwnedSnapshotError) throw error;
    throw new WindowsOwnedSnapshotError({
      operation: 'owned_snapshot', reason: queryCode === 'ETIMEDOUT' ? 'query_timeout'
        : queryCode === 'ENOENT' ? 'spawn_error' : 'query_exit', root_pid: rootPid,
      last_phase: error instanceof WindowsQueryExecutionError ? error.lastPhase : null,
      requested_count: new Set(requestedPids.filter((pid) => pid !== rootPid)).size,
      returned_count: 0, incomplete_count: 0,
    });
  }
}

async function captureProcessSnapshotUnbounded(): Promise<readonly ProcessIdentitySnapshot[]> {
  if (process.platform === 'win32') {
    throw new Error('Windows process snapshot requires an owned root PID');
  }
  if (process.platform === 'linux') {
    const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
    return (await Promise.all(entries.map((entry) => readLinuxProcessIdentitySample(Number(entry))))).filter(
      (identity): identity is ProcessIdentitySnapshot => identity !== null,
    );
  }
  const result = await execFileAsync('ps', macProcessSnapshotArgs(), MAC_PS_OPTIONS);
  return parseMacProcessSnapshotOutput(result.stdout);
}

export async function waitForDead(
  pids: readonly number[],
  timeoutMs: number,
  alive: (pid: number) => boolean = processAlive,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pids.some(alive)) {
    if (Date.now() >= deadline) throw new ProcessSurvivorsError(pids.filter(alive));
    await Bun.sleep(WAIT_STEP_MS);
  }
}

function defaultSignal(pid: number, signal: 'SIGTERM' | 'SIGKILL'): void {
  process.kill(pid, process.platform === 'win32' ? undefined : signal);
}

export class IdentityMismatchError extends Error {
  constructor(pid: number, reason: 'unknown' | 'mismatch') {
    super(`process identity ${reason} for PID ${pid}; refusing to signal`);
    this.name = 'ProcessIdentityMismatchError';
  }
}

type Verification = 'dead' | 'match' | 'unknown' | 'mismatch';

export class ProcessRegistry {
  private readonly registrations = new Map<number, ProcessRegistration>();
  private rootWasClosed = false;
  private readonly captureIdentity: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
  private readonly liveness: (pid: number) => ProcessLiveness | Promise<ProcessLiveness>;
  private readonly signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => unknown;
  private readonly requireTestMarker: boolean;
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly termWaitMs: number;
  private readonly killWaitMs: number;
  private readonly waitStepMs: number;
  private cleanupPromise: Promise<void> | undefined;

  constructor(options: ProcessRegistryOptions = {}) {
    this.captureIdentity = options.captureIdentity ?? captureProcessIdentity;
    this.liveness = options.liveness ?? (options.alive === undefined ? processLiveness : async (pid) => options.alive!(pid) ? 'alive' : 'absent');
    this.signal = options.signal ?? defaultSignal;
    this.platform = options.platform ?? process.platform;
    this.requireTestMarker = options.requireTestMarker ?? this.platform === 'linux';
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? Bun.sleep;
    this.termWaitMs = options.timing?.termWaitMs ?? TERM_WAIT_MS;
    this.killWaitMs = options.timing?.killWaitMs ?? KILL_WAIT_MS;
    this.waitStepMs = options.timing?.waitStepMs ?? WAIT_STEP_MS;
  }

  private claim(pid: number, identity?: ProcessIdentitySnapshot): boolean {
    if (!validPid(pid) || (identity !== undefined && (identity.pid !== pid || !completeIdentity(identity, this.requireTestMarker)))) return false;
    const owner = owners.get(pid);
    if (owner !== undefined && owner.registry !== this) return false;
    owners.set(pid, { registry: this, identity });
    return true;
  }

  registerPid(
    pid: number | undefined,
    identity: ProcessIdentitySnapshot,
    metadata: { readonly ports?: readonly number[]; readonly role?: 'worker' | 'ingress' },
  ): number | undefined {
    if (!validPid(pid) || identity === undefined || !this.claim(pid, identity)) return undefined;
    const existing = this.registrations.get(pid);
    this.registrations.set(pid, {
      ...(existing ?? { pid }),
      pid, identity,
      ...(metadata.role === undefined && existing?.role === undefined ? {} : { role: metadata.role ?? existing?.role }),
      ...(metadata.ports === undefined && existing?.ports === undefined ? {} : { ports: metadata.ports ?? existing?.ports }),
    });
    for (const port of metadata.ports ?? existing?.ports ?? []) portOwners.set(port, this);
    return pid;
  }

  registerChild(child: ProcessHandle, identity?: ProcessIdentitySnapshot, metadata: { readonly ports?: readonly number[] } = {}): ProcessHandle {
    if (validPid(child.pid) && this.claim(child.pid, identity)) {
      this.registrations.set(child.pid, { pid: child.pid, handle: child, ...(identity === undefined ? {} : { identity }),
        ...(metadata.ports === undefined ? {} : { ports: metadata.ports }) });
      for (const port of metadata.ports ?? []) portOwners.set(port, this);
    }
    return child;
  }

  setIdentity(pid: number, identity: ProcessIdentitySnapshot): boolean {
    const registration = this.registrations.get(pid);
    const owner = owners.get(pid);
    if (registration === undefined || owner?.registry !== this || identity.pid !== pid
      || !completeIdentity(identity, this.requireTestMarker)) return false;
    this.registrations.set(pid, { ...registration, identity });
    owners.set(pid, { registry: this, identity });
    return true;
  }

  /** Commit an already-validated ownership set without exposing an intermediate state. */
  registerExactProcesses(entries: readonly ExactProcessRegistration[]): boolean {
    const unique = new Map<number, ExactProcessRegistration>();
    const adopt = [] as Array<{ readonly registry: ProcessRegistry; readonly pid: number }>;
    for (const entry of entries) {
      if (unique.has(entry.identity.pid) || !completeIdentity(entry.identity, this.requireTestMarker)) return false;
      unique.set(entry.identity.pid, entry);
    }
    for (const entry of unique.values()) {
      const pid = entry.identity.pid;
      const owner = owners.get(pid);
      if (owner !== undefined && owner.registry !== this) {
        if (entry.role !== 'worker' || !owner.registry.canAdoptWorker(pid)) return false;
        adopt.push({ registry: owner.registry, pid });
      }
      for (const port of entry.ports ?? []) {
        const portOwner = portOwners.get(port);
        if (portOwner !== undefined && portOwner !== this) return false;
      }
    }
    for (const { registry, pid } of adopt) registry.releaseAdoptedWorker(pid);
    for (const entry of unique.values()) {
      const pid = entry.identity.pid;
      const existing = this.registrations.get(pid);
      this.registrations.set(pid, {
        ...(existing ?? { pid }), pid, identity: entry.identity,
        ...(entry.role === undefined && existing?.role === undefined ? {} : { role: entry.role ?? existing?.role }),
        ...(entry.ports === undefined && existing?.ports === undefined ? {} : { ports: entry.ports ?? existing?.ports }),
      });
      owners.set(pid, { registry: this, identity: entry.identity });
      for (const port of entry.ports ?? existing?.ports ?? []) portOwners.set(port, this);
    }
    return true;
  }

  registerAdoptedIngress(
    pid: number,
    ports: readonly number[] | number,
    identity: ProcessIdentitySnapshot,
  ): number | undefined {
    const portList = typeof ports === 'number' ? [ports] : [...ports];
    if (portList.some((port) => portOwners.get(port) !== undefined && portOwners.get(port) !== this)) return undefined;
    const registered = this.registerPid(pid, identity, { ports: portList, role: 'ingress' });
    if (registered === undefined) return undefined;
    for (const port of portList) portOwners.set(port, this);
    return registered;
  }

  registerPids(identities: readonly ProcessIdentitySnapshot[]): void {
    for (const identity of identities) this.registerPid(identity.pid, identity, { role: 'worker' });
  }

  release(identity: ProcessIdentitySnapshot): boolean {
    const owner = owners.get(identity.pid);
    const registration = this.registrations.get(identity.pid);
    if (owner?.registry !== this || registration?.identity === undefined || !processIdentityMatches(registration.identity, identity, this.platform)) return false;
    owners.delete(identity.pid);
    this.registrations.delete(identity.pid);
    for (const port of registration.ports ?? []) if (portOwners.get(port) === this) portOwners.delete(port);
    return true;
  }

  /** Release only this exact registered handle; a reused PID can never match by number alone. */
  releaseHandle(handle: ProcessHandle): boolean {
    const registration = [...this.registrations.values()].find((entry) => entry.handle === handle);
    if (registration === undefined) return false;
    if (registration.role === undefined) this.rootWasClosed = true;
    this.releaseGoneExactOwner(registration);
    if (this.registrations.get(registration.pid) === registration) this.registrations.delete(registration.pid);
    return true;
  }

  /** Confirm that this exact handle closed without probing or signalling its PID. */
  confirmHandleClosed(handle: ProcessHandle): boolean {
    return this.releaseHandle(handle);
  }

  get registeredPids(): readonly number[] {
    return [...this.registrations.keys()];
  }

  get registeredProcesses(): readonly RegisteredProcessSnapshot[] {
    return [...this.registrations.values()].map(({ pid, handle, identity, role, ports }) => ({
      pid, hasLiveHandle: handle !== undefined, ...(identity === undefined ? {} : { identity }),
      ...(role === undefined ? {} : { role }), ...(ports === undefined ? {} : { ports }),
    }));
  }

  ownsPid(pid: number): boolean {
    return this.registrations.has(pid);
  }

  hasLiveHandle(pid: number): boolean {
    const handle = this.registrations.get(pid)?.handle;
    return handle !== undefined;
  }

  portOwnedByAnother(port: number): boolean {
    const owner = portOwners.get(port);
    return owner !== undefined && owner !== this;
  }

  portOwnedByThis(port: number): boolean {
    return portOwners.get(port) === this;
  }

  cleanup(optionsOrShutdown: ProcessCleanupOptions | CleanupShutdown = { expectGraceful: false }): Promise<void> {
    if (this.cleanupPromise !== undefined) return this.cleanupPromise;
    const options: ProcessCleanupOptions = typeof optionsOrShutdown === 'function'
      ? { expectGraceful: true, shutdown: optionsOrShutdown }
      : optionsOrShutdown;
    this.cleanupPromise = (async () => {
      try { await this.runCleanup(options); }
      finally { this.cleanupPromise = undefined; }
    })();
    return this.cleanupPromise;
  }

  private async verify(registration: ProcessRegistration): Promise<Verification> {
    const initial = await this.liveness(registration.pid);
    if (initial === 'absent' || initial === 'terminal') return 'dead';
    if (initial === 'unknown') return 'unknown';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = await this.captureIdentity(registration.pid);
      if (actual !== null) {
        if (registration.identity === undefined && registration.handle !== undefined) return 'match';
        return registration.identity !== undefined && processIdentityMatches(registration.identity, actual, this.platform) ? 'match' : 'mismatch';
      }
      const state = await this.liveness(registration.pid);
      if (state === 'absent' || state === 'terminal') return 'dead';
      if (state === 'unknown') return 'unknown';
      await this.sleep(this.waitStepMs);
    }
    return 'unknown';
  }

  private async waitForRegistrations(registrations: readonly ProcessRegistration[], timeoutMs: number): Promise<readonly ProcessRegistration[]> {
    const deadline = this.now() + timeoutMs;
    for (;;) {
      const settled = await Promise.allSettled(registrations.map(async (registration) => ({ registration, state: await this.verify(registration) })));
      const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'process verification failed');
      const states = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const alive = states.filter(({ state }) => state === 'match').map(({ registration }) => registration);
      if (alive.length === 0) return [];
      if (this.now() >= deadline) return alive;
      await this.sleep(this.waitStepMs);
    }
  }

  /** Release an owner whose exact process instance is already gone without touching a replacement PID. */
  private releaseGoneExactOwner(registration: ProcessRegistration): void {
    const owner = owners.get(registration.pid);
    if (owner?.registry !== this) return;
    owners.delete(registration.pid);
    for (const port of registration.ports ?? []) if (portOwners.get(port) === this) portOwners.delete(port);
  }

  private canAdoptWorker(pid: number): boolean {
    const registration = this.registrations.get(pid);
    return this.rootWasClosed && registration?.role === 'worker';
  }

  private releaseAdoptedWorker(pid: number): void {
    if (!this.canAdoptWorker(pid)) throw new Error(`worker PID ${pid} is no longer adoptable`);
    const registration = this.registrations.get(pid);
    if (registration === undefined) throw new Error(`worker PID ${pid} registration disappeared`);
    this.releaseGoneExactOwner(registration);
    this.registrations.delete(pid);
  }

  private async signalMatching(
    registrations: readonly ProcessRegistration[],
    signal: 'SIGTERM' | 'SIGKILL',
    errors: unknown[],
    evidence: ProcessCleanupEvidenceRecorder,
    blocked = new Set<ProcessRegistration>(),
    unknownBlocked = new Set<ProcessRegistration>(),
  ): Promise<void> {
    const verifyAfterSignalFailure = async (registration: ProcessRegistration, error: unknown): Promise<boolean> => {
      let state: Verification;
      try { state = await this.verify(registration); }
      catch (probeError) {
        blocked.add(registration);
        unknownBlocked.add(registration);
        evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'probe_error', signal, probeError);
        errors.push(probeError);
        return true;
      }
      if (state === 'dead' || state === 'mismatch') {
        if (state === 'mismatch') evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'identity_mismatch', signal);
        this.releaseGoneExactOwner(registration);
        return true;
      }
      blocked.add(registration);
      if (state === 'unknown') {
        unknownBlocked.add(registration);
        evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'identity_unknown', signal);
        errors.push(new IdentityMismatchError(registration.pid, state));
      } else {
        evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'signal_error', signal, error);
        errors.push(error);
      }
      return true;
    };
    const verified = await Promise.allSettled(registrations.map(async (registration) => ({
      registration, state: await this.verify(registration),
    })));
    for (const [index, result] of verified.entries()) {
      try {
        if (result.status === 'rejected') {
          blocked.add(registrations[index]!);
          unknownBlocked.delete(registrations[index]!);
          evidence.add(registrations[index]!, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'probe_error', signal, result.reason);
          errors.push(result.reason);
          continue;
        }
        const { registration, state } = result.value;
        if (state === 'dead') continue;
        if (state !== 'match') {
          if (state === 'unknown' && registration.identity === undefined && registration.handle?.kill !== undefined) {
            let signalError: unknown;
            try {
              if (registration.handle.kill(this.platform === 'win32' ? undefined : signal) === false) {
                signalError = new Error(`handle signal ${signal} rejected for PID ${registration.pid}`);
              }
            } catch (error) { signalError = error; }
            if (signalError !== undefined) {
              evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_signal' : 'sigkill_signal', 'signal_error', signal, signalError);
              if (errorCode(signalError) === 'ESRCH' || signalError instanceof Error && signalError.message.includes('rejected')) {
                await verifyAfterSignalFailure(registration, signalError);
              } else {
                errors.push(signalError);
              }
            }
            continue;
          }
          if (state === 'unknown') {
            // A failed/ambiguous probe is permanently non-signalable for this cleanup run.
            // Retrying it for KILL would turn an observation failure into a PID-reuse race.
            blocked.add(registration);
            unknownBlocked.add(registration);
            evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'identity_unknown', signal);
            errors.push(new IdentityMismatchError(registration.pid, state));
            continue;
          }
          evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_verify' : 'sigkill_verify', 'identity_mismatch', signal);
          this.releaseGoneExactOwner(registration);
          continue;
        }
        let signalError: unknown;
        if (registration.identity !== undefined) {
          try {
            if (this.signal(registration.pid, signal) === false) signalError = new Error(`signal ${signal} rejected for PID ${registration.pid}`);
          } catch (error) { signalError = error; }
        } else if (registration.handle?.kill !== undefined) {
          try {
            if (registration.handle.kill(this.platform === 'win32' ? undefined : signal) === false) {
              signalError = new Error(`handle signal ${signal} rejected for PID ${registration.pid}`);
            }
          } catch (error) { signalError = error; }
        } else {
          try {
            if (this.signal(registration.pid, signal) === false) signalError = new Error(`signal ${signal} rejected for PID ${registration.pid}`);
          } catch (error) { signalError = error; }
        }
        if (signalError !== undefined) {
          evidence.add(registration, signal === 'SIGTERM' ? 'sigterm_signal' : 'sigkill_signal', 'signal_error', signal, signalError);
          if (errorCode(signalError) === 'ESRCH' || signalError instanceof Error && signalError.message.includes('rejected')) {
            await verifyAfterSignalFailure(registration, signalError);
          } else {
            errors.push(signalError);
          }
        }
      } catch (error) {
        evidence.add(registrations[index]!, signal === 'SIGTERM' ? 'sigterm_signal' : 'sigkill_signal', 'signal_error', signal, error);
        errors.push(error);
      }
    }
  }

  private async runCleanup(options: ProcessCleanupOptions): Promise<void> {
    const registrations = [...this.registrations.values()];
    const errors: unknown[] = [];
    const evidence = new ProcessCleanupEvidenceRecorder();
    const blocked = new Set<ProcessRegistration>();
    const unknownBlocked = new Set<ProcessRegistration>();
    const recordAll = (
      items: readonly ProcessRegistration[], phase: ProcessCleanupEvidencePhase,
      signal: ProcessCleanupEvidenceSignal, error: unknown,
    ): void => { for (const registration of items) evidence.add(registration, phase, 'probe_error', signal, error); };
    const classify = async (
      registration: ProcessRegistration,
      phase: ProcessCleanupEvidencePhase,
      signal: ProcessCleanupEvidenceSignal,
      deferUnknown = false,
    ): Promise<Verification> => {
      if (blocked.has(registration)) {
        if (!deferUnknown || !unknownBlocked.delete(registration)) return 'unknown';
        blocked.delete(registration);
      }
      try {
        const state = await this.verify(registration);
        if (state === 'unknown' && registration.identity === undefined && registration.handle?.kill !== undefined) return 'match';
        if (state === 'dead') this.releaseGoneExactOwner(registration);
        if (state === 'mismatch') {
          evidence.add(registration, phase, 'identity_mismatch', signal);
          this.releaseGoneExactOwner(registration);
        }
        if (state === 'unknown') {
          if (deferUnknown) return state;
          blocked.add(registration);
          evidence.add(registration, phase, 'identity_unknown', signal);
          errors.push(new IdentityMismatchError(registration.pid, state));
        }
        return state;
      } catch (error) {
        blocked.add(registration);
        evidence.add(registration, phase, 'probe_error', signal, error);
        errors.push(error);
        return 'unknown';
      }
    };
    const wait = async (
      items: readonly ProcessRegistration[], timeoutMs: number, phase: string, reportTimeout: boolean,
      evidencePhase: ProcessCleanupEvidencePhase, evidenceSignal: ProcessCleanupEvidenceSignal,
      deferUnknown: boolean,
    ): Promise<readonly ProcessRegistration[]> => {
      try {
        const deadline = this.now() + timeoutMs;
        let survivors: readonly ProcessRegistration[] = [];
        for (;;) {
          const states = await Promise.all(items.map(async (registration) => ({
            registration, state: await classify(registration, evidencePhase, evidenceSignal, deferUnknown),
          })));
          survivors = states.filter(({ state }) => state === 'match').map(({ registration }) => registration);
          const pending = states.filter(({ registration, state }) => state === 'unknown' && !blocked.has(registration)).map(({ registration }) => registration);
          if (survivors.length === 0 && pending.length === 0 || this.now() >= deadline) {
            if (reportTimeout) {
              for (const registration of pending) {
                blocked.add(registration);
                evidence.add(registration, evidencePhase, 'identity_unknown', evidenceSignal);
                errors.push(new IdentityMismatchError(registration.pid, 'unknown'));
              }
              if (survivors.length > 0) {
                for (const registration of survivors) evidence.add(registration, evidencePhase, 'survivor', evidenceSignal);
                errors.push(new ProcessSurvivorsError(survivors.map(({ pid }) => pid), phase));
              }
            }
            return reportTimeout ? survivors : [...survivors, ...pending];
          }
          await this.sleep(this.waitStepMs);
        }
      } catch (error) {
        recordAll(items, evidencePhase, evidenceSignal, error);
        errors.push(error);
        return items;
      }
    };
    let gracefulSurvivors: readonly ProcessRegistration[] = registrations;
    if (options.expectGraceful) {
      try { await options.shutdown?.(); } catch (error) { recordAll(registrations, 'sigterm_verify', 'none', error); errors.push(error); }
      try {
        gracefulSurvivors = await wait(registrations, this.termWaitMs, 'graceful wait', true, 'sigterm_wait', 'none', true);
        if (gracefulSurvivors.length > 0) {
          errors.push(new Error(`production graceful shutdown leak: ${gracefulSurvivors.map(({ pid }) => pid).join(',')}`));
        }
      } catch (error) { recordAll(registrations, 'sigterm_wait', 'none', error); errors.push(error); }
      try { await options.observeGraceful?.(); } catch (error) { recordAll(registrations, 'sigterm_wait', 'none', error); errors.push(error); }
    }
    await this.signalMatching(registrations.filter((registration) => !blocked.has(registration)), 'SIGTERM', errors, evidence, blocked, unknownBlocked);
    let survivors = await wait(registrations, this.termWaitMs, 'SIGTERM wait', false, 'sigterm_wait', 'SIGTERM', true);
    await this.signalMatching(survivors.filter((registration) => !blocked.has(registration)), 'SIGKILL', errors, evidence, blocked, unknownBlocked);
    survivors = await wait(survivors, this.killWaitMs, 'SIGKILL wait', true, 'sigkill_wait', 'SIGKILL', true);
    if (survivors.length > 0) errors.push(new Error(`registered processes remained alive: ${survivors.map(({ pid }) => pid).join(',')}`));
    for (const registration of registrations) await classify(registration, 'final_verify', 'none');
    if (errors.length > 0) {
      throw attachProcessCleanupEvidence(new AggregateError(errors, 'registered process cleanup failed'), registrations, evidence);
    }
    for (const registration of registrations) {
      if (this.registrations.get(registration.pid) === registration) this.registrations.delete(registration.pid);
    }
  }
}

export function cleanupProcesses(
  registry: ProcessRegistry,
  optionsOrShutdown: ProcessCleanupOptions | CleanupShutdown = { expectGraceful: false },
): Promise<void> {
  return registry.cleanup(optionsOrShutdown);
}
