import { execFile as nodeExecFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { promisify } from 'node:util';
import type { DaemonMetadataV1 } from '@jeffusion/bungee-types';
import { captureDarwinProcessTree, captureProcessTree, processTreeDepth, readDarwinProcessSnapshot, readProcessTreeSnapshot, sameProcessTreeSnapshot, type ProcessTreeSnapshot } from './process-tree';
import type { MarkerProbe, ProcessIdentity, ProcessProbe } from './process-identity';

const execFile = promisify(nodeExecFile);
const TASKKILL_OPTIONS = { timeout: 5_000, killSignal: 'SIGKILL' as const, maxBuffer: 64 * 1024, windowsHide: true };

export type ForceStopDependencies = Readonly<{
  platform: NodeJS.Platform;
  probeProcess: (pid: number, identity: ProcessIdentity, bootNonce: string) => Promise<ProcessProbe>;
  findProcess: (bootNonce: string) => Promise<MarkerProbe>;
  kill: (pid: number, signal: NodeJS.Signals | number) => void | boolean;
  taskkill?: (pid: number) => Promise<void>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  forceWaitMs?: number;
  freezeWaitMs?: number;
  resumeWaitMs?: number;
  captureTree?: (rootPid: number) => Promise<readonly ProcessTreeSnapshot[]>;
  readSnapshot?: (pid: number) => Promise<ProcessTreeSnapshot>;
}>;

function identityOf(metadata: DaemonMetadataV1): ProcessIdentity { return { executable: metadata.executable, entrypoint: metadata.entrypoint }; }
function pidOf(metadata: DaemonMetadataV1): number {
  const pid = metadata.pid;
  if (pid === null || !Number.isSafeInteger(pid) || pid <= 0) throw new Error('daemon PID is unavailable for force stop');
  return pid;
}

export function canonicalTaskkillPath(): string {
  const root = process.env.SystemRoot;
  if (root === undefined || root.length === 0) throw new Error('Windows SystemRoot is unavailable');
  const canonicalRoot = (() => { try { return realpathSync.native(root); } catch { throw new Error('Windows SystemRoot is unavailable'); } })();
  const expected = join(canonicalRoot, 'System32', 'taskkill.exe');
  let actual: string;
  try { actual = realpathSync.native(expected); }
  catch { throw new Error('Windows taskkill executable is unavailable'); }
  const normalize = (value: string) => win32.normalize(value).replaceAll('\\', '/').toLowerCase();
  if (normalize(actual) !== normalize(expected) || !normalize(actual).endsWith('/system32/taskkill.exe')) throw new Error('Windows taskkill executable is invalid');
  return actual;
}

export function taskkillInvocation(pid: number): { readonly file: string; readonly args: readonly string[]; readonly options: typeof TASKKILL_OPTIONS } {
  return { file: canonicalTaskkillPath(), args: ['/PID', String(pid), '/T', '/F'], options: TASKKILL_OPTIONS };
}

async function taskkill(pid: number): Promise<void> {
  const invocation = taskkillInvocation(pid);
  await execFile(invocation.file, [...invocation.args], invocation.options);
}

function missing(error: unknown): boolean { return error instanceof Error && error.name === 'TargetProcessMissingError'; }

function validateTree(tree: readonly ProcessTreeSnapshot[], rootPid: number, uid: number): Map<number, ProcessTreeSnapshot> {
  const byPid = new Map<number, ProcessTreeSnapshot>();
  for (const snapshot of tree) {
    if (byPid.has(snapshot.pid) || snapshot.uid !== uid) throw new Error('daemon process tree identity is unavailable');
    byPid.set(snapshot.pid, snapshot);
  }
  if (!byPid.has(rootPid)) throw new Error('daemon root process tree identity is unavailable');
  for (const snapshot of tree) {
    if (snapshot.pid === rootPid) continue;
    if (snapshot.processIdentity === undefined || snapshot.processIdentity === null) throw new Error('daemon child identity marker is missing');
    let parent = snapshot.ppid;
    const seen = new Set<number>();
    while (parent !== rootPid) {
      if (seen.has(parent)) throw new Error('daemon process tree has a parent cycle');
      seen.add(parent);
      const parentSnapshot = byPid.get(parent);
      if (parentSnapshot === undefined) throw new Error('daemon process tree parent is unavailable');
      parent = parentSnapshot.ppid;
    }
  }
  return byPid;
}

function sameSnapshotIgnoringUid(left: ProcessTreeSnapshot, right: ProcessTreeSnapshot): boolean {
  return left.pid === right.pid && left.ppid === right.ppid && left.startTime === right.startTime
    && left.executable === right.executable && left.rawCommand === right.rawCommand
    && left.bootNonce === right.bootNonce && left.processIdentity === right.processIdentity && left.role === right.role
    && left.cmdline.length === right.cmdline.length && left.cmdline.every((value, index) => value === right.cmdline[index]);
}

function sameSnapshotIgnoringState(left: ProcessTreeSnapshot, right: ProcessTreeSnapshot): boolean {
  return sameSnapshotIgnoringUid(left, right);
}

function stopped(state: string): boolean { return state.startsWith('T') || state.startsWith('t'); }
function validChildMarker(value: string | null | undefined): boolean { return value !== null && value !== undefined && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value); }

function transient(error: unknown): boolean {
  return error instanceof Error && !missing(error) && (error as NodeJS.ErrnoException).code !== 'ESRCH';
}

async function forcePosix(metadata: DaemonMetadataV1, options: ForceStopDependencies): Promise<void> {
  if (options.platform !== 'linux' && options.platform !== 'darwin') throw new Error('POSIX force stop is unsupported on this platform');
  const pid = pidOf(metadata);
  const identity = identityOf(metadata);
  const initial = await options.probeProcess(pid, identity, metadata.boot_nonce);
  if (initial === 'unknown') throw new Error('daemon process identity is unknown');
  if (initial !== 'exact') return;

  // Freeze the root before any terminating signal. This closes the fork race before hard kill.
  const capture = options.captureTree ?? (options.platform === 'darwin' ? captureDarwinProcessTree : captureProcessTree);
  if (capture === undefined) throw new Error('POSIX process tree snapshot is unavailable');
  const tree0 = await capture(pid);
  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  const expectedUid = currentUid ?? tree0.find((snapshot) => snapshot.pid === pid)?.uid;
  if (expectedUid === undefined) throw new Error('current process uid is unavailable');
  const verifiedUid = expectedUid;
  const tree0ByPid = validateTree(tree0, pid, verifiedUid);
  const root0 = tree0.find((snapshot) => snapshot.pid === pid);
  if (root0 === undefined || root0.uid !== verifiedUid
    || root0.executable !== metadata.executable || root0.bootNonce !== metadata.boot_nonce) {
    throw new Error('daemon root identity is unavailable for force stop');
  }
  const readSnapshot = options.readSnapshot ?? (options.platform === 'darwin' ? readDarwinProcessSnapshot : readProcessTreeSnapshot);
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const freezeWaitMs = options.freezeWaitMs ?? 1_000;
  const resumeWaitMs = options.resumeWaitMs ?? 1_000;
  const frozen = new Map<number, ProcessTreeSnapshot>();
  const stoppedCandidates = new Map<number, ProcessTreeSnapshot>();
  const killPath = new Set<number>();
  const killErrors: unknown[] = [];
  const waitFrozen = async (expected: ProcessTreeSnapshot, root: boolean): Promise<ProcessTreeSnapshot> => {
    const deadline = now() + freezeWaitMs;
    let lastError: unknown;
    while (now() < deadline) {
      try {
        const current = await readSnapshot(expected.pid);
        if (current.uid !== verifiedUid || !sameSnapshotIgnoringState(current, expected)) throw new Error('daemon process identity changed while freezing');
        if (!root && !validChildMarker(current.processIdentity)) throw new Error('daemon child identity marker is missing');
        if (root && await options.probeProcess(pid, identity, metadata.boot_nonce) !== 'exact') throw new Error('daemon root identity changed while freezing');
        if (stopped(current.state)) return current;
      } catch (error) {
        if (missing(error)) throw new Error('daemon process exited before freeze');
        if (!transient(error)) throw error;
        lastError = error;
      }
      await sleep(Math.min(25, Math.max(1, deadline - now())));
    }
    throw lastError instanceof Error ? lastError : new Error('daemon process did not reach stopped state');
  };
  try {
    try { if (options.kill(pid, 'SIGSTOP') === false) throw new Error('SIGSTOP returned false'); }
    catch { throw new Error('daemon root could not be stopped safely'); }
    stoppedCandidates.set(pid, root0);
    frozen.set(pid, await waitFrozen(root0, true));
    const initialDescendants = tree0.filter((snapshot) => snapshot.pid !== pid)
      .sort((left, right) => processTreeDepth(left, new Map(tree0.map((snapshot) => [snapshot.pid, snapshot]))) - processTreeDepth(right, new Map(tree0.map((snapshot) => [snapshot.pid, snapshot]))));
    for (const snapshot of initialDescendants) {
      const current = await readSnapshot(snapshot.pid);
      if (current.uid !== verifiedUid || !sameSnapshotIgnoringState(current, snapshot) || !validChildMarker(current.processIdentity)) throw new Error('daemon child identity changed while freezing');
      try { if (options.kill(snapshot.pid, 'SIGSTOP') === false) throw new Error('SIGSTOP returned false'); }
      catch { throw new Error('daemon child could not be stopped safely'); }
      stoppedCandidates.set(snapshot.pid, snapshot);
      frozen.set(snapshot.pid, await waitFrozen(snapshot, false));
    }
    const stoppedRoot = await options.probeProcess(pid, identity, metadata.boot_nonce);
    if (stoppedRoot !== 'exact') throw new Error('daemon root identity changed while stopping');
    let stableCaptures = 0;
    for (let captureRound = 0; captureRound < 3 && stableCaptures < 2; captureRound += 1) {
      const tree1 = await capture(pid);
      validateTree(tree1, pid, verifiedUid);
      const root1 = tree1.find((snapshot) => snapshot.pid === pid);
      if (root1 === undefined || root1.uid !== root0.uid || !sameSnapshotIgnoringState(root0, root1) || !stopped(root1.state)) throw new Error('daemon root snapshot changed while safely stopped');
      let added = false;
      for (const snapshot of tree1) {
        const previous = tree0ByPid.get(snapshot.pid);
        if (previous !== undefined && !sameSnapshotIgnoringState(previous, snapshot)) throw new Error('daemon process tree identity changed while safely stopped');
        if (previous === undefined) {
          if (snapshot.ppid !== pid && !tree0ByPid.has(snapshot.ppid)) throw new Error('daemon process tree parent is unavailable');
          const current = await readSnapshot(snapshot.pid);
          if (current.uid !== verifiedUid || !sameSnapshotIgnoringState(current, snapshot) || !validChildMarker(current.processIdentity)) throw new Error('daemon child identity marker is missing');
          try { if (options.kill(snapshot.pid, 'SIGSTOP') === false) throw new Error('SIGSTOP returned false'); }
          catch { throw new Error('daemon child could not be stopped safely'); }
          stoppedCandidates.set(snapshot.pid, snapshot);
          frozen.set(snapshot.pid, await waitFrozen(snapshot, false));
          tree0ByPid.set(snapshot.pid, snapshot);
          added = true;
        }
      }
      stableCaptures = added ? 0 : stableCaptures + 1;
    }
    if (stableCaptures < 2) throw new Error('daemon process tree did not stabilize while safely stopped');

    const expectedTree = [...frozen.values()];
    const oldSnapshotPresent = async (expected: ProcessTreeSnapshot): Promise<boolean> => {
      try {
        if (expected.pid === pid) {
          const probe = await options.probeProcess(pid, identity, metadata.boot_nonce);
          if (probe === 'unknown') throw new Error('daemon root identity became unknown');
          if (probe !== 'exact') return false;
          const rootSnapshot = await readSnapshot(pid);
          if (rootSnapshot.uid !== verifiedUid && sameSnapshotIgnoringUid(rootSnapshot, expected)) throw new Error('daemon root uid changed');
          return rootSnapshot.uid === verifiedUid && sameProcessTreeSnapshot(rootSnapshot, expected);
        }
        const current = await readSnapshot(expected.pid);
        if (current.uid !== verifiedUid && sameSnapshotIgnoringUid(current, expected)) throw new Error('daemon descendant uid changed');
        return current.uid === verifiedUid && sameProcessTreeSnapshot(current, expected);
      } catch (error) {
        if (missing(error)) return false;
        throw new Error('daemon process tree identity became unknown');
      }
    };
    const byPid = new Map(expectedTree.map((snapshot) => [snapshot.pid, snapshot]));
    const survivors: ProcessTreeSnapshot[] = [];
    for (const expected of expectedTree) if (await oldSnapshotPresent(expected)) survivors.push(expected);
    const ordered = survivors.filter((snapshot) => snapshot.pid !== pid)
      .sort((left, right) => processTreeDepth(right, byPid) - processTreeDepth(left, byPid));
    for (const expected of ordered) {
      const current = await readSnapshot(expected.pid);
      if (current.uid !== verifiedUid && sameSnapshotIgnoringUid(current, expected)) throw new Error('daemon descendant uid changed');
      if (!sameProcessTreeSnapshot(current, expected) || current.uid !== verifiedUid || !validChildMarker(current.processIdentity)) throw new Error('daemon descendant identity became unknown');
      try { if (options.kill(expected.pid, 'SIGKILL') === false) throw new Error('SIGKILL returned false'); killPath.add(expected.pid); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          if (await oldSnapshotPresent(expected)) killErrors.push(new Error('daemon descendant remained after SIGKILL failure'));
        } else killErrors.push(error);
      }
    }
    const rootProbe = await options.probeProcess(pid, identity, metadata.boot_nonce);
    if (rootProbe === 'unknown') throw new Error('daemon root identity became unknown');
    if (rootProbe === 'exact') {
      const rootSnapshot = await readSnapshot(pid);
      if (rootSnapshot.uid !== verifiedUid && sameSnapshotIgnoringUid(rootSnapshot, root0)) throw new Error('daemon root uid changed');
      if (!sameSnapshotIgnoringState(rootSnapshot, root0) || rootSnapshot.uid !== verifiedUid) throw new Error('daemon root identity became unknown');
      try { if (options.kill(pid, 'SIGKILL') === false) throw new Error('SIGKILL returned false'); killPath.add(pid); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
          if (await oldSnapshotPresent(root0)) killErrors.push(new Error('daemon root remained after SIGKILL failure'));
        } else killErrors.push(error);
      }
    }
    const postKillDeadline = now() + (options.forceWaitMs ?? 1_500);
    for (;;) {
      let survivor = false;
      for (const expected of expectedTree) if (await oldSnapshotPresent(expected)) survivor = true;
      if (!survivor) break;
      if (now() >= postKillDeadline) { killErrors.push(new Error('forced daemon process tree did not disappear')); break; }
      await sleep(Math.min(50, Math.max(1, postKillDeadline - now())));
    }
    if (killErrors.length > 0) throw new AggregateError(killErrors, 'daemon process tree kill failed');
  } catch (primary) {
    const resumeErrors: unknown[] = [];
    const resumeOne = async (expected: ProcessTreeSnapshot): Promise<void> => {
      const deadline = now() + resumeWaitMs;
      let sent = false;
      let lastError: unknown;
      while (now() < deadline) {
        try {
          let current: ProcessTreeSnapshot | null;
          if (expected.pid === pid) {
            const probe = await options.probeProcess(pid, identity, metadata.boot_nonce);
            if (probe === 'unknown') throw new Error('daemon root identity became unknown while resuming');
            current = probe === 'exact' ? await readSnapshot(pid) : null;
          } else current = await readSnapshot(expected.pid);
          if (current === null) return;
          if (current.uid !== verifiedUid && sameSnapshotIgnoringUid(current, expected)) throw new Error('daemon process uid changed while resuming');
          if (!sameSnapshotIgnoringState(current, expected) || current.uid !== verifiedUid) return;
          if (!stopped(current.state)) return;
          if (!sent) {
            if (options.kill(expected.pid, 'SIGCONT') === false) throw new Error('SIGCONT returned false');
            sent = true;
          }
          lastError = undefined;
        } catch (error) {
          if (missing(error)) return;
          lastError = error;
        }
        await sleep(Math.min(25, Math.max(1, deadline - now())));
      }
      if (lastError !== undefined) throw lastError;
      throw new Error('daemon process did not resume in time');
    };
    const resumeTree = [...stoppedCandidates.values()].sort((left, right) => {
      const byPid = new Map(stoppedCandidates.values().map((snapshot) => [snapshot.pid, snapshot]));
      return processTreeDepth(right, byPid) - processTreeDepth(left, byPid);
    });
    for (const expected of resumeTree) {
      if (killPath.has(expected.pid)) continue;
      try { await resumeOne(expected); }
      catch (error) { if (!missing(error)) resumeErrors.push(error); }
    }
    const errors = killErrors.length > 0 ? [primary, ...killErrors, ...resumeErrors] : [primary, ...resumeErrors];
    throw resumeErrors.length === 0 && killErrors.length === 0 ? primary : new AggregateError(errors, 'daemon force stop failed');
  }
}

export async function forceStopDaemon(metadata: DaemonMetadataV1, options: ForceStopDependencies): Promise<void> {
  const pid = pidOf(metadata);
  const identity = identityOf(metadata);
  if (options.platform === 'win32') {
    const before = await options.probeProcess(pid, identity, metadata.boot_nonce);
    if (before === 'unknown') throw new Error('daemon process identity is unknown');
    if (before !== 'exact') return;
    let taskkillError: unknown;
    try { await (options.taskkill ?? taskkill)(pid); }
    catch (error) { taskkillError = error; }
    const after = await options.probeProcess(pid, identity, metadata.boot_nonce);
    if (after === 'unknown') throw taskkillError ?? new Error('forced daemon process identity is unknown');
    if (after === 'exact') throw taskkillError ?? new Error('forced daemon process did not disappear');
    if (await options.findProcess(metadata.boot_nonce) !== 'none') throw taskkillError ?? new Error('daemon boot is still present');
    return;
  }
  await forcePosix(metadata, options);
}
