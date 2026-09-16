import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';
import type { WindowsAclAdapter } from '@jeffusion/bungee-types/daemon-file';
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

function deterministicWindowsAcl(): WindowsAclAdapter {
  const currentSid = 'S-1-5-21-1000-1000-1000-1000';
  let securedKind: 'directory' | 'file' | undefined;
  const entries = (kind: 'directory' | 'file') => [
    { sid: currentSid, access: 'allow' as const, rights: 2_032_127, inheritance: kind === 'directory' ? 3 : 0, propagation: 0, inherited: false },
    { sid: 'S-1-5-18', access: 'allow' as const, rights: 2_032_127, inheritance: kind === 'directory' ? 3 : 0, propagation: 0, inherited: false },
    { sid: 'S-1-5-32-544', access: 'allow' as const, rights: 2_032_127, inheritance: kind === 'directory' ? 3 : 0, propagation: 0, inherited: false },
  ];
  return {
    read: async () => ({ currentSid, entries: securedKind === undefined ? [] : entries(securedKind) }),
    set: async (_path, _sid, kind = 'file') => { securedKind = kind; },
  };
}

export function createTestManager(
  spawnDaemon?: DaemonSpawn,
  processControl?: { readonly kill: (pid: number, signal: NodeJS.Signals | number) => void },
  dependencies: DaemonManagerDependencies = {},
): DaemonManager {
  return new DaemonManager(spawnDaemon, processControl, {
    processPlatform: process.platform,
    filePlatform: process.platform,
    windowsAcl: deterministicWindowsAcl(),
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
