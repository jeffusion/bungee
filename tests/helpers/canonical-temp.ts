import { chmodSync, mkdtempSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { posix, win32 } from 'node:path';

export type CanonicalTempFsAdapter = {
  readonly realpathSync: (path: string) => string;
  readonly mkdtempSync: (prefix: string) => string;
  readonly chmodSync?: (path: string, mode: number) => void;
};

export type CanonicalTempOptions = {
  readonly daemonSafe?: boolean;
  readonly platform?: NodeJS.Platform;
  readonly tmpdir?: () => string;
  readonly homedir?: () => string;
  readonly fs?: CanonicalTempFsAdapter;
};

const defaultFs: CanonicalTempFsAdapter = {
  realpathSync: path => realpathSync(path),
  mkdtempSync: prefix => mkdtempSync(prefix),
  chmodSync: (path, mode) => chmodSync(path, mode),
};

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

function isStrictChild(parent: string, child: string, api: typeof posix): boolean {
  const relative = api.relative(parent, child);
  return relative.length > 0 && !api.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`${api.sep}..`)
    && !relative.startsWith(`..${api.sep}`);
}

function validatePrefix(prefix: string): void {
  if (prefix.includes('\0')) throw new Error('temporary directory prefix must not contain NUL');
  if (prefix.includes('/') || prefix.includes('\\')) {
    throw new Error('temporary directory prefix must not contain path separators');
  }
  if (prefix.includes('..')) throw new Error('temporary directory prefix must not contain ..');
}

/**
 * Returns the physical parent root for fixtures.
 *
 * This never creates a directory. In Windows daemon-safe mode the parent is the
 * canonical home directory; makeCanonicalTempDir creates the single child there.
 * Consumer-controlled paths are deliberately not resolved here, so hostile
 * symlink behavior remains visible to the consumer instead of being masked by
 * the test helper.
 */
export function canonicalTempRoot(options: CanonicalTempOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const fs = options.fs ?? defaultFs;
  const canonicalize = (path: string): string => fs.realpathSync(path);

  if (platform === 'win32' && options.daemonSafe === true) {
    return canonicalize((options.homedir ?? homedir)());
  }

  return canonicalize((options.tmpdir ?? tmpdir)());
}

/** Creates a canonical, uniquely named fixture directory below the selected root. */
export function makeCanonicalTempDir(
  prefix: string,
  options: CanonicalTempOptions = {},
): string {
  validatePrefix(prefix);
  const fs = options.fs ?? defaultFs;
  const platform = options.platform ?? process.platform;
  const api = pathApi(platform);
  const root = canonicalTempRoot(options);
  const daemonSafe = platform === 'win32' && options.daemonSafe === true;
  const created = fs.mkdtempSync(api.join(root, daemonSafe ? `.bungee-daemon-safe-${prefix}-` : `${prefix}-`));
  if (daemonSafe) {
    fs.chmodSync?.(created, 0o700);
    const canonicalCreated = fs.realpathSync(created);
    if (!isStrictChild(root, canonicalCreated, api)) {
      throw new Error('daemon-safe temporary directory must be a strict child of the canonical home directory');
    }
    return canonicalCreated;
  }
  return fs.realpathSync(created);
}
