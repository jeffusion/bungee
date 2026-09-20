import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, resolve, win32 } from 'node:path';
import type { DaemonFileOptions, WindowsAclAdapter, WindowsAclEntry, WindowsAclSnapshot } from '@jeffusion/bungee-types/daemon-file';
import { ConfigPaths } from '../config/paths';
import { DaemonManager, type DaemonManagerDependencies, type DaemonSpawn } from './manager';

export type CanonicalTempFs = Readonly<{
  realpathSync: (path: string) => string;
  mkdtempSync: (prefix: string) => string;
}>;

export type CanonicalTempOptions = Readonly<{
  daemonSafe?: boolean;
  platform?: NodeJS.Platform;
  homedir?: () => string;
  tmpdir?: () => string;
  fs?: CanonicalTempFs;
}>;

const nativeFs: CanonicalTempFs = { realpathSync, mkdtempSync };

export type MemoryWindowsAclState = Readonly<{
  owner: string;
  inheritance: number;
  entries: readonly WindowsAclEntry[];
}>;

export type MemoryWindowsAcl = WindowsAclAdapter & Readonly<{
  states: Map<string, MemoryWindowsAclState>;
  reads: { count: number };
  sets: { count: number };
}>;

function canonicalAclPath(path: string): string {
  try { return realpathSync.native(resolve(path)).toLowerCase(); }
  catch { return resolve(path).toLowerCase(); }
}

function securedSnapshot(owner: string, kind: 'directory' | 'file'): WindowsAclSnapshot {
  const inheritance = kind === 'directory' ? 3 : 0;
  return {
    currentSid: owner,
    entries: [
      { sid: owner, access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
      { sid: 'S-1-5-18', access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
      { sid: 'S-1-5-32-544', access: 'allow', rights: 2_032_127, inheritance, propagation: 0, inherited: false },
    ],
  };
}

export function createMemoryWindowsAcl(): MemoryWindowsAcl {
  const states = new Map<string, MemoryWindowsAclState>();
  const reads = { count: 0 };
  const sets = { count: 0 };
  return {
    states,
    reads,
    sets,
    read: async (path) => {
      reads.count += 1;
      const state = states.get(canonicalAclPath(path));
      return state === undefined ? { currentSid: 'S-1-5-21-1000-1000-1000-1000', entries: [] } : {
        currentSid: state.owner,
        entries: state.entries,
      };
    },
    set: async (path, currentSid, kind = 'file') => {
      sets.count += 1;
      const snapshot = securedSnapshot(currentSid, kind);
      states.set(canonicalAclPath(path), {
        owner: snapshot.currentSid,
        inheritance: kind === 'directory' ? 3 : 0,
        entries: snapshot.entries,
      });
    },
  };
}

export function optionsFor(
  runtimeDirectory: string,
  windowsAcl?: MemoryWindowsAcl,
): DaemonFileOptions & { readonly windowsAcl: MemoryWindowsAcl } {
  const key = canonicalAclPath(runtimeDirectory);
  const cached = optionsByRuntime.get(key);
  if (windowsAcl !== undefined || cached === undefined) {
    const options = { runtimeDirectory, platform: process.platform, windowsAcl: windowsAcl ?? createMemoryWindowsAcl() };
    optionsByRuntime.set(key, options);
    return options;
  }
  return cached;
}

const optionsByRuntime = new Map<string, DaemonFileOptions & { readonly windowsAcl: MemoryWindowsAcl }>();

export function createTestManager(
  spawnDaemon?: DaemonSpawn,
  processControl?: { readonly kill: (pid: number, signal: NodeJS.Signals | number) => void },
  dependencies: DaemonManagerDependencies = {},
): DaemonManager {
  const file = optionsFor(dependencies.runtimeDirectory ?? ConfigPaths.RUNTIME_DIR);
  return new DaemonManager(spawnDaemon, processControl, {
    processPlatform: process.platform,
    filePlatform: process.platform,
    windowsAcl: file.windowsAcl,
    ...dependencies,
  });
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function isStrictChild(parent: string, child: string, api: typeof posix): boolean {
  const relative = api.relative(parent, child);
  return relative.length > 0 && !api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${api.sep}`);
}

export function canonicalTempRoot(options: CanonicalTempOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? nativeFs;
  const canonicalize = (path: string): string => fs.realpathSync(path);
  return canonicalize((platform === 'win32' && options.daemonSafe === true
    ? options.homedir ?? homedir
    : options.tmpdir ?? tmpdir)());
}

export function makeCanonicalTempDir(prefix: string, options: CanonicalTempOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const fs = options.fs ?? nativeFs;
  const root = canonicalTempRoot(options);
  const safe = platform === 'win32' && options.daemonSafe === true;
  const created = fs.mkdtempSync(api.join(root, safe ? `.bungee-daemon-safe-${prefix}-` : `${prefix}-`));
  const canonical = fs.realpathSync(created);
  if (safe && !isStrictChild(root, canonical, api)) throw new Error('daemon-safe temporary directory escaped canonical home');
  return canonical;
}
