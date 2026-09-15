import { mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

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
