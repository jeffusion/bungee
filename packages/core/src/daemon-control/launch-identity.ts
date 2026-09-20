import { realpathSync } from 'node:fs';
import { posix, win32 } from 'node:path';

export const DAEMON_BOOT_MARKER_PREFIX = '--bungee-daemon-boot=';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class LaunchIdentityError extends Error {
  readonly name = 'LaunchIdentityError';
  constructor(readonly code: 'marker' | 'entrypoint' | 'identity', message: string) { super(message); }
}

export type ParsedDaemonBootMarker = {
  readonly bootNonce: string | null;
  readonly argv: readonly string[];
};

export function parseDaemonBootMarker(argv: readonly string[]): ParsedDaemonBootMarker {
  let bootNonce: string | null = null;
  const remaining: string[] = [];
  for (const argument of argv) {
    if (argument === '--bungee-daemon-boot' || argument.startsWith(DAEMON_BOOT_MARKER_PREFIX)) {
      if (bootNonce !== null) throw new LaunchIdentityError('marker', 'duplicate daemon boot marker');
      const value = argument.startsWith(DAEMON_BOOT_MARKER_PREFIX)
        ? argument.slice(DAEMON_BOOT_MARKER_PREFIX.length) : '';
      if (!UUID.test(value)) throw new LaunchIdentityError('marker', 'daemon boot marker is malformed');
      bootNonce = value;
      continue;
    }
    remaining.push(argument);
  }
  return Object.freeze({ bootNonce, argv: Object.freeze(remaining) });
}

export type LaunchIdentity = {
  readonly executable: string;
  readonly entrypoint: string | null;
};

export type LaunchIdentityInput = {
  readonly execPath: string;
  readonly argv: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly realpath?: (path: string) => string;
};

function canonical(path: string, platform: NodeJS.Platform): string {
  const value = (platform === 'win32' ? win32.normalize(path) : posix.normalize(path)).split('\\').join('/');
  return platform === 'win32' ? value.toLowerCase() : value;
}

function nativeRealpath(path: string): string {
  try { return realpathSync.native(path); }
  catch (error) { throw new LaunchIdentityError('identity', `launch identity path cannot be canonicalized: ${String(error)}`); }
}

export function resolveLaunchIdentity(input: LaunchIdentityInput): LaunchIdentity {
  const currentPlatform = input.platform ?? process.platform;
  const resolvePath = input.realpath ?? nativeRealpath;
  const executable = resolvePath(input.execPath);
  const entry = input.argv[1];
  if (entry === undefined || canonical(entry, currentPlatform) === canonical(input.execPath, currentPlatform)) {
    return Object.freeze({ executable, entrypoint: null });
  }
  const portableEntry = entry.replaceAll('\\', '/');
  if (portableEntry.startsWith('/$bunfs/root/') || /^[A-Za-z]:\/~BUN\/root\//.test(portableEntry)) {
    return Object.freeze({ executable, entrypoint: null });
  }
  const pathApi = currentPlatform === 'win32' ? win32 : posix;
  const wrapper = /^(?:run|watch|shell|exec|x|--watch|--hot|--smol|--cwd(?:=|$))/i.test(entry);
  if (wrapper) {
    throw new LaunchIdentityError('entrypoint', 'daemon master must be launched directly from an absolute .js or .ts entrypoint');
  }
  if (entry.startsWith('-')) return Object.freeze({ executable, entrypoint: null });
  if (!pathApi.isAbsolute(entry) && /\.(?:js|ts)$/i.test(pathApi.basename(entry))) {
    throw new LaunchIdentityError('entrypoint', 'daemon master must be launched directly from an absolute .js or .ts entrypoint');
  }
  if (!pathApi.isAbsolute(entry)) return Object.freeze({ executable, entrypoint: null });
  if (!/\.(?:js|ts)$/i.test(pathApi.basename(entry))) {
    throw new LaunchIdentityError('entrypoint', 'daemon master must be launched directly from an absolute .js or .ts entrypoint');
  }
  return Object.freeze({ executable, entrypoint: resolvePath(entry) });
}

export function launchIdentityMatches(expected: LaunchIdentity, actual: LaunchIdentity, platform: NodeJS.Platform = process.platform): boolean {
  const left = canonical(expected.executable, platform);
  const right = canonical(actual.executable, platform);
  const leftEntry = expected.entrypoint === null ? null : canonical(expected.entrypoint, platform);
  const rightEntry = actual.entrypoint === null ? null : canonical(actual.entrypoint, platform);
  return left === right && leftEntry === rightEntry;
}

export function currentLaunchIdentity(argv: readonly string[] = process.argv): LaunchIdentity {
  return resolveLaunchIdentity({ execPath: process.execPath, argv });
}

export const parseDaemonLaunchIdentity = parseDaemonBootMarker;
export const resolveCurrentLaunchIdentity = currentLaunchIdentity;
