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
  readonly captureIdentity?: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
  readonly alive?: (pid: number) => boolean | Promise<boolean>;
  readonly signal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  readonly requireTestMarker?: boolean;
  readonly platform?: NodeJS.Platform;
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
  return `$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress`;
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

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2, stat.lastIndexOf(')') + 3) === 'Z') return false;
    } catch { /* process state is unavailable on non-Linux hosts */ }
    return true;
  } catch (error) {
    if (errorCode(error) === 'ESRCH') return false;
    throw error;
  }
}

async function linuxProcessIdentity(pid: number): Promise<ProcessIdentitySnapshot | null> {
  try {
    const [stat, executable, cmdline, environ] = await Promise.all([
      readFile(`/proc/${pid}/stat`, 'utf8'),
      readlink(`/proc/${pid}/exe`),
      readFile(`/proc/${pid}/cmdline`, 'utf8'),
      readFile(`/proc/${pid}/environ`, 'utf8'),
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
      const result = await execFileAsync('powershell.exe', [
        '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsProcessIdentityCommand(pid),
      ], { timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: PROCESS_PROBE_MAX_BUFFER });
      return parseWindowsProcessIdentityOutput(result.stdout);
    } catch (error) {
      if (['ESRCH', 'ENOENT', 'EACCES'].includes(errorCode(error) ?? '')) return null;
      throw error;
    }
  }
  if (process.platform === 'linux') return withProbeTimeout(linuxProcessIdentity(pid), pid);
  return withProbeTimeout(captureMacProcessIdentity(pid), pid);
}

export async function captureProcessSnapshot(): Promise<readonly ProcessIdentitySnapshot[]> {
  return withProbeTimeout(captureProcessSnapshotUnbounded());
}

async function captureProcessSnapshotUnbounded(): Promise<readonly ProcessIdentitySnapshot[]> {
  if (process.platform === 'win32') {
    const command = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine | ConvertTo-Json -Compress";
    const result = await execFileAsync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
      timeout: PROCESS_PROBE_TIMEOUT_MS, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: PROCESS_PROBE_MAX_BUFFER,
    });
    let parsed: unknown;
    try { parsed = JSON.parse(result.stdout.trim()); } catch (error) { throw new Error('Windows process snapshot was not valid JSON', { cause: error }); }
    return (Array.isArray(parsed) ? parsed : [parsed]).flatMap((item) => parseWindowsProcessIdentityOutput(JSON.stringify(item)) ?? []);
  }
  if (process.platform === 'linux') {
    const entries = (await readdir('/proc')).filter((entry) => /^\d+$/.test(entry));
    return (await Promise.all(entries.map((entry) => linuxProcessIdentity(Number(entry))))).filter(
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
  try {
    process.kill(pid, process.platform === 'win32' ? undefined : signal);
  } catch (error) {
    if (errorCode(error) !== 'ESRCH') throw error;
  }
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
  private readonly captureIdentity: (pid: number) => Promise<ProcessIdentitySnapshot | null>;
  private readonly alive: (pid: number) => boolean | Promise<boolean>;
  private readonly signal: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void;
  private readonly requireTestMarker: boolean;
  private readonly platform: NodeJS.Platform;
  private cleanupPromise: Promise<void> | undefined;

  constructor(options: ProcessRegistryOptions = {}) {
    this.captureIdentity = options.captureIdentity ?? captureProcessIdentity;
    this.alive = options.alive ?? processAlive;
    this.signal = options.signal ?? defaultSignal;
    this.platform = options.platform ?? process.platform;
    this.requireTestMarker = options.requireTestMarker ?? this.platform === 'linux';
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
    return handle !== undefined && handle.exitCode === null && handle.signalCode === null;
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
    if (registration.handle?.exitCode !== null && registration.handle?.exitCode !== undefined) return 'dead';
    if (registration.handle?.signalCode !== null && registration.handle?.signalCode !== undefined) return 'dead';
    if (!(await this.alive(registration.pid))) return 'dead';
    if (registration.handle !== undefined && registration.identity === undefined) return 'match';
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const actual = await this.captureIdentity(registration.pid);
      if (actual !== null) return registration.identity !== undefined && processIdentityMatches(registration.identity, actual, this.platform) ? 'match' : 'mismatch';
      if (!(await this.alive(registration.pid))) return 'dead';
      await Bun.sleep(WAIT_STEP_MS);
    }
    return 'unknown';
  }

  private async waitForRegistrations(registrations: readonly ProcessRegistration[], timeoutMs: number): Promise<readonly ProcessRegistration[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const settled = await Promise.allSettled(registrations.map(async (registration) => ({ registration, state: await this.verify(registration) })));
      const failures = settled.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'process verification failed');
      const states = settled.flatMap((result) => result.status === 'fulfilled' ? [result.value] : []);
      const alive = states.filter(({ state }) => state === 'match').map(({ registration }) => registration);
      if (alive.length === 0) return [];
      if (Date.now() >= deadline) return alive;
      await Bun.sleep(WAIT_STEP_MS);
    }
  }

  /** Release an owner whose exact process instance is already gone without touching a replacement PID. */
  private releaseGoneExactOwner(registration: ProcessRegistration): void {
    const owner = owners.get(registration.pid);
    if (owner?.registry !== this) return;
    owners.delete(registration.pid);
    for (const port of registration.ports ?? []) if (portOwners.get(port) === this) portOwners.delete(port);
  }

  private async signalMatching(
    registrations: readonly ProcessRegistration[],
    signal: 'SIGTERM' | 'SIGKILL',
    errors: unknown[],
    blocked = new Set<ProcessRegistration>(),
  ): Promise<void> {
    const verified = await Promise.allSettled(registrations.map(async (registration) => ({
      registration, state: await this.verify(registration),
    })));
    for (const [index, result] of verified.entries()) {
      try {
        if (result.status === 'rejected') {
          blocked.add(registrations[index]!);
          errors.push(result.reason);
          continue;
        }
        const { registration, state } = result.value;
        if (state === 'dead') continue;
        if (state !== 'match') {
          if (state === 'unknown') {
            // A failed/ambiguous probe is permanently non-signalable for this cleanup run.
            // Retrying it for KILL would turn an observation failure into a PID-reuse race.
            blocked.add(registration);
            errors.push(new IdentityMismatchError(registration.pid, state));
            continue;
          }
          this.releaseGoneExactOwner(registration);
          continue;
        }
        if (registration.handle?.kill !== undefined) {
          registration.handle.kill(process.platform === 'win32' ? undefined : signal);
        } else {
          this.signal(registration.pid, signal);
        }
      } catch (error) { errors.push(error); }
    }
  }

  private async runCleanup(options: ProcessCleanupOptions): Promise<void> {
    const registrations = [...this.registrations.values()];
    const errors: unknown[] = [];
    const blocked = new Set<ProcessRegistration>();
    const classify = async (registration: ProcessRegistration): Promise<Verification> => {
      if (blocked.has(registration)) return 'unknown';
      try {
        const state = await this.verify(registration);
        if (state === 'dead' || state === 'mismatch') this.releaseGoneExactOwner(registration);
        if (state === 'unknown') {
          blocked.add(registration);
          errors.push(new IdentityMismatchError(registration.pid, state));
        }
        return state;
      } catch (error) {
        blocked.add(registration);
        errors.push(error);
        return 'unknown';
      }
    };
    const wait = async (items: readonly ProcessRegistration[], timeoutMs: number, phase: string, reportTimeout = false): Promise<readonly ProcessRegistration[]> => {
      try {
        const deadline = Date.now() + timeoutMs;
        let survivors: readonly ProcessRegistration[] = [];
        for (;;) {
          const states = await Promise.all(items.map(async (registration) => ({ registration, state: await classify(registration) })));
          survivors = states.filter(({ state }) => state === 'match').map(({ registration }) => registration);
          if (survivors.length === 0 || Date.now() >= deadline) break;
          await Bun.sleep(WAIT_STEP_MS);
        }
        if (reportTimeout && survivors.length > 0) errors.push(new ProcessSurvivorsError(survivors.map(({ pid }) => pid), phase));
        return survivors;
      } catch (error) {
        errors.push(error);
        return items;
      }
    };
    let gracefulSurvivors: readonly ProcessRegistration[] = registrations;
    if (options.expectGraceful) {
      try { await options.shutdown?.(); } catch (error) { errors.push(error); }
      try {
        gracefulSurvivors = await wait(registrations, TERM_WAIT_MS, 'graceful wait', true);
        if (gracefulSurvivors.length > 0) {
          errors.push(new Error(`production graceful shutdown leak: ${gracefulSurvivors.map(({ pid }) => pid).join(',')}`));
        }
      } catch (error) { errors.push(error); }
      try { await options.observeGraceful?.(); } catch (error) { errors.push(error); }
    }
    await this.signalMatching(registrations.filter((registration) => !blocked.has(registration)), 'SIGTERM', errors, blocked);
    let survivors = await wait(registrations, TERM_WAIT_MS, 'SIGTERM wait');
    await this.signalMatching(survivors.filter((registration) => !blocked.has(registration)), 'SIGKILL', errors, blocked);
    survivors = await wait(survivors, KILL_WAIT_MS, 'SIGKILL wait', true);
    if (survivors.length > 0) errors.push(new Error(`registered processes remained alive: ${survivors.map(({ pid }) => pid).join(',')}`));
    for (const registration of registrations) await classify(registration);
    if (errors.length > 0) throw new AggregateError(errors, 'registered process cleanup failed');
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
