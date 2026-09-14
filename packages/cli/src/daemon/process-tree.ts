import { realpath, readdir, readFile } from 'node:fs/promises';
import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import { exactBootMarker, parseLinuxProcStatState, TargetProcessMissingError, type ProcessAliveProbe } from './process-identity';

export type ProcessTreeSnapshot = Readonly<{
  pid: number;
  ppid: number;
  startTime: string;
  state: string;
  uid: number;
  executable: string;
  cmdline: readonly string[];
  rawCommand?: string;
  bootNonce: string | null;
  processIdentity?: string | null;
  role: string | null;
}>;

const BOOT_PREFIX = '--bungee-daemon-boot=';
const PROBE_TIMEOUT_MS = 5_000;
const execFile = promisify(nodeExecFile);
const PS_OPTIONS = { timeout: PROBE_TIMEOUT_MS, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024, windowsHide: true, env: { ...process.env, LC_ALL: 'C', LANG: 'C' } };
export type DarwinSnapshotOptions = Readonly<{
  readonly execFile?: typeof execFile;
  readonly liveness?: (pid: number) => Promise<ProcessAliveProbe>;
}>;

function normalizedExecutable(value: string): string {
  return value.endsWith(' (deleted)') ? value.slice(0, -' (deleted)'.length) : value;
}

function statParts(value: string): { state: string; ppid: number; startTime: string } {
  const end = value.lastIndexOf(')');
  if (end < 0) throw new Error('invalid process stat');
  const parts = value.slice(end + 2).trim().split(/\s+/);
  const ppid = Number(parts[1]);
  const startTime = parts[19];
  if (!Number.isSafeInteger(ppid) || startTime === undefined) throw new Error('invalid process stat');
  return { state: parts[0] ?? '', ppid, startTime };
}

function uidFromStatus(value: string): number {
  const match = /^Uid:\s+(\d+)/m.exec(value);
  const uid = Number(match?.[1]);
  if (!Number.isSafeInteger(uid)) throw new Error('process uid is unavailable');
  return uid;
}

function bootFromArgv(argv: readonly string[]): string | null {
  const markers = argv.filter((value) => value.startsWith(BOOT_PREFIX));
  if (markers.length !== 1 || !exactBootMarker(argv, markers[0]!.slice(BOOT_PREFIX.length))) return null;
  return markers[0]!.slice(BOOT_PREFIX.length);
}

function processIdentityFromArgv(argv: readonly string[]): string | null {
  const prefix = '--bungee-process-identity=';
  const markers = argv.filter((value) => value.startsWith(prefix));
  if (markers.length !== 1 || markers[0]!.slice(prefix.length).length === 0) return null;
  const identity = markers[0]!.slice(prefix.length);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(identity) ? identity : null;
}

function markerFromRawCommand(command: string, prefix: string): string | null {
  const values = [...command.matchAll(new RegExp(`(?:^|\\s)${prefix.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}([^\\s]+)(?=\\s|$)`, 'g'))].map((match) => match[1]!);
  return values.length === 1 && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(values[0]!) ? values[0]! : null;
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error('process tree probe timed out')), PROBE_TIMEOUT_MS);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

export async function readProcessTreeSnapshot(pid: number): Promise<ProcessTreeSnapshot> {
  const root = `/proc/${pid}`;
  const [statText, command, status, executable] = await bounded(Promise.all([
    readFile(`${root}/stat`, 'utf8'), readFile(`${root}/cmdline`), readFile(`${root}/status`, 'utf8'), realpath(`${root}/exe`),
  ]));
  const parsed = statParts(statText);
  if (parsed.state === 'Z') throw new TargetProcessMissingError(`process ${pid} is a zombie`);
  const cmdline = command.toString().split('\0').filter(Boolean);
  const env = await bounded(readFile(`${root}/environ`));
  const roleEntry = env.toString().split('\0').find((value) => value.startsWith('BUNGEE_ROLE='));
  return {
    pid, ppid: parsed.ppid, startTime: parsed.startTime, state: parsed.state, uid: uidFromStatus(status),
    executable: normalizedExecutable(executable), cmdline, bootNonce: bootFromArgv(cmdline), processIdentity: processIdentityFromArgv(cmdline), role: roleEntry?.slice('BUNGEE_ROLE='.length) ?? null,
  };
}

export async function captureProcessTree(rootPid: number): Promise<readonly ProcessTreeSnapshot[]> {
  const entries = await bounded(readdir('/proc'));
  const pids = entries.filter((entry) => /^\d+$/.test(entry)).map(Number);
  const parents = new Map<number, { ppid: number; startTime: string }>();
  for (const pid of pids) {
    try {
      const parsed = statParts(await readFile(`/proc/${pid}/stat`, 'utf8'));
      if (parsed.state !== 'Z') parents.set(pid, { ppid: parsed.ppid, startTime: parsed.startTime });
    }
    catch (error) {
      if (error instanceof TargetProcessMissingError) continue;
      // Unrelated protected processes must not prevent a safe tree snapshot.
    }
  }
  if (!parents.has(rootPid)) throw new Error('root process tree identity is unavailable');
  const treePids = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, parent] of parents) {
      if (treePids.has(parent.ppid) && !treePids.has(pid)) { treePids.add(pid); changed = true; }
    }
  }
  const snapshots: ProcessTreeSnapshot[] = [];
  for (const pid of treePids) snapshots.push(await readProcessTreeSnapshot(pid));
  const byPid = new Map(snapshots.map((snapshot) => [snapshot.pid, snapshot]));
  const result: ProcessTreeSnapshot[] = [];
  const addDescendants = (pid: number) => {
    for (const snapshot of snapshots) {
      if (snapshot.ppid === pid) { result.push(snapshot); addDescendants(snapshot.pid); }
    }
  };
  result.push(byPid.get(rootPid)!);
  addDescendants(rootPid);
  return result;
}

function parseDarwinLine(line: string): ProcessTreeSnapshot {
  // lstart is a fixed five-word/24-column field; the final command field is deliberately kept whole.
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.+?)\s*$/.exec(line);
  if (match === null) throw new Error('invalid ps process record');
  const pid = Number(match[1]);
  const ppid = Number(match[2]);
  const uid = Number(match[3]);
  if (!Number.isSafeInteger(pid) || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(uid)) throw new Error('invalid ps process identity');
  const command = match[6]!;
  if (command.length === 0) throw new Error('ps process command is unavailable');
  return { pid, ppid, uid, state: match[4]!, startTime: match[5]!, executable: '', cmdline: [command], rawCommand: command, bootNonce: markerFromRawCommand(command, '--bungee-daemon-boot='), processIdentity: markerFromRawCommand(command, '--bungee-process-identity='), role: null };
}

async function darwinExecutable(pid: number, options: DarwinSnapshotOptions = {}): Promise<string> {
  const { stdout } = await bounded((options.execFile ?? execFile)('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'txt', '-Fn'], PS_OPTIONS));
  const names = stdout.toString().split(/\r?\n/).filter((line) => line.startsWith('n')).map((line) => line.slice(1)).filter(Boolean);
  if (names.length !== 1) throw new Error('darwin executable identity is unavailable');
  return realpath(names[0]!);
}

export async function captureDarwinProcessTree(rootPid: number, options: DarwinSnapshotOptions = {}): Promise<readonly ProcessTreeSnapshot[]> {
  const run = options.execFile ?? execFile;
  const { stdout } = await bounded(run('ps', ['-ww', '-axo', 'pid=,ppid=,uid=,state=,lstart=,command='], PS_OPTIONS));
  const records: ProcessTreeSnapshot[] = [];
  for (const line of stdout.toString().split(/\r?\n/).filter((value) => value.trim().length > 0)) {
    try { records.push(parseDarwinLine(line)); } catch { /* An unrelated malformed ps row is not a tree identity. */ }
  }
  const byPid = new Map(records.map((record) => [record.pid, record]));
  if (!byPid.has(rootPid)) throw new Error('root process tree identity is unavailable');
  const selected = new Set<number>([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const record of records) {
      if (selected.has(record.ppid) && !selected.has(record.pid)) { selected.add(record.pid); changed = true; }
    }
  }
  const selectedRecords = await Promise.all(records.filter((record) => selected.has(record.pid)).map(async (record) => ({ ...record, executable: await darwinExecutable(record.pid, options) })));
  const selectedByPid = new Map(selectedRecords.map((record) => [record.pid, record]));
  return selectedRecords.sort((left, right) => processTreeDepth(left, selectedByPid) - processTreeDepth(right, selectedByPid));
}

export async function readDarwinProcessSnapshot(pid: number, options: DarwinSnapshotOptions = {}): Promise<ProcessTreeSnapshot> {
  const run = options.execFile ?? execFile;
  let stdout: string | Buffer;
  try { ({ stdout } = await bounded(run('ps', ['-ww', '-p', String(pid), '-o', 'pid=,ppid=,uid=,state=,lstart=,command='], PS_OPTIONS))); }
  catch (error) {
    const code: unknown = (error as { readonly code?: unknown }).code;
    if (code === 1 || code === '1') {
      const alive = await (options.liveness ?? ((target: number) => new Promise<ProcessAliveProbe>((resolve) => {
        try { process.kill(target, 0); resolve('alive'); } catch (probeError) { resolve((probeError as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown'); }
      })))(pid).catch(() => 'unknown' as const);
      if (alive === 'dead') throw new TargetProcessMissingError(`target process ${pid} is missing`);
    }
    throw error;
  }
  const line = stdout.toString().split(/\r?\n/).find((value) => value.trim().length > 0);
  if (line === undefined) throw new TargetProcessMissingError(`target process ${pid} is missing`);
  return { ...parseDarwinLine(line), executable: await darwinExecutable(pid, options) };
}

export function sameProcessTreeSnapshot(left: ProcessTreeSnapshot, right: ProcessTreeSnapshot): boolean {
  return left.pid === right.pid && left.ppid === right.ppid && left.startTime === right.startTime && left.uid === right.uid
    && left.executable === right.executable && left.rawCommand === right.rawCommand && left.bootNonce === right.bootNonce && left.processIdentity === right.processIdentity && left.role === right.role
    && left.cmdline.length === right.cmdline.length && left.cmdline.every((value, index) => value === right.cmdline[index]);
}

export function processTreeDepth(snapshot: ProcessTreeSnapshot, byPid: ReadonlyMap<number, ProcessTreeSnapshot>): number {
  let depth = 0;
  let current = snapshot;
  const seen = new Set<number>();
  while (byPid.has(current.ppid) && !seen.has(current.ppid)) {
    seen.add(current.ppid);
    depth += 1;
    current = byPid.get(current.ppid)!;
  }
  return depth;
}
