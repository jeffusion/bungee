import { timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { join, win32 } from 'node:path';
import { realpath } from 'node:fs/promises';
import {
  decodeDaemonShutdownSecret,
  type DaemonMetadataV1,
} from '@jeffusion/bungee-types';
import {
  readDaemonMetadataFile,
  transitionDaemonMetadataFile,
  deleteDaemonMetadataForMaster,
  type DaemonFileOptions,
} from '@jeffusion/bungee-types/daemon-file';
import {
  currentLaunchIdentity,
  launchIdentityMatches,
  type LaunchIdentity,
} from './launch-identity';

export const DAEMON_BOOTSTRAP_ENV_NAMES = Object.freeze({
  metadataPath: 'BUNGEE_DAEMON_METADATA_PATH',
  bootNonce: 'BUNGEE_DAEMON_BOOT_NONCE',
  shutdownSecret: 'BUNGEE_DAEMON_SHUTDOWN_SECRET',
});

export type DaemonBootstrapEnvironment = Readonly<Record<string, string | undefined>>;

export type DaemonBootstrap = {
  readonly metadataPath: string;
  readonly bootNonce: string;
  readonly shutdownSecret: string;
  readonly pid: number;
  readonly metadata: DaemonMetadataV1;
  readonly store: {
    readonly file: DaemonFileOptions;
    readonly read: typeof readDaemonMetadataFile;
    readonly transition: typeof transitionDaemonMetadataFile;
    readonly deleteForMaster: typeof deleteDaemonMetadataForMaster;
  };
};

export type DaemonBootstrapTakeoverOptions = {
  readonly env?: NodeJS.ProcessEnv | DaemonBootstrapEnvironment;
  readonly marker: string | null;
  readonly pid?: number;
  readonly identity?: LaunchIdentity;
  readonly file?: DaemonFileOptions;
  readonly readMetadata?: typeof readDaemonMetadataFile;
  readonly transitionMetadata?: typeof transitionDaemonMetadataFile;
  readonly deleteMetadata?: typeof deleteDaemonMetadataForMaster;
  readonly runtimeDirectory?: string;
};

export class DaemonBootstrapError extends Error {
  readonly name = 'DaemonBootstrapError';
  constructor(readonly code: 'environment' | 'identity' | 'metadata' | 'secret' | 'transition', message: string) { super(message); }
}

export function clearDaemonBootstrapEnvironment(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): void {
  const names = new Set(Object.values(DAEMON_BOOTSTRAP_ENV_NAMES).map((name) => name.toLowerCase()));
  for (const key of Object.keys(env)) if (names.has(key.toLowerCase())) delete env[key];
}

function constantTimeSecretMatches(left: string, right: string): boolean {
  try {
    const a = decodeDaemonShutdownSecret(left);
    const b = decodeDaemonShutdownSecret(right);
    return a.byteLength === b.byteLength && timingSafeEqual(a, b);
  } catch { return false; }
}

function bootstrapEnvValue(env: DaemonBootstrapEnvironment, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function bootstrapValues(env: DaemonBootstrapEnvironment): { path: string; boot: string; secret: string } | null {
  const path = bootstrapEnvValue(env, DAEMON_BOOTSTRAP_ENV_NAMES.metadataPath);
  const boot = bootstrapEnvValue(env, DAEMON_BOOTSTRAP_ENV_NAMES.bootNonce);
  const secret = bootstrapEnvValue(env, DAEMON_BOOTSTRAP_ENV_NAMES.shutdownSecret);
  if (path === undefined && boot === undefined && secret === undefined) return null;
  if (path === undefined || boot === undefined || secret === undefined || path.length === 0 || boot.length === 0 || secret.length === 0) {
    throw new DaemonBootstrapError('environment', 'daemon bootstrap environment must be complete');
  }
  const result = { path, boot, secret };
  // Copy first, then remove the source before any metadata or ACL operation.
  clearDaemonBootstrapEnvironment(env as Record<string, string | undefined>);
  return result;
}

function runtimeDirectory(options: DaemonBootstrapTakeoverOptions): string {
  return options.runtimeDirectory ?? join(homedir(), '.bungee', 'run');
}

async function exactMetadataTarget(path: string, options: DaemonBootstrapTakeoverOptions): Promise<{ readonly root: string; readonly target: string }> {
  const root = await realpath(runtimeDirectory(options));
  const target = join(root, 'daemon.json');
  const canonical = (value: string) => (process.platform === 'win32' ? win32.normalize(value).toLowerCase() : value);
  if (canonical(path) !== canonical(target)) throw new DaemonBootstrapError('environment', 'daemon metadata path is not the canonical runtime target');
  return { root, target };
}

export async function takeOverDaemonBootstrap(options: DaemonBootstrapTakeoverOptions): Promise<DaemonBootstrap | null> {
  const env = options.env ?? process.env;
  const bootstrapNames = new Set(Object.values(DAEMON_BOOTSTRAP_ENV_NAMES).map((name) => name.toLowerCase()));
  const hasBootstrapEnvironment = Object.keys(env).some((name) => bootstrapNames.has(name.toLowerCase()));
  let candidate: { path: string; boot: string; secret: string } | null = null;
  try {
    candidate = bootstrapValues(env);
    if (candidate === null && options.marker === null) return null;
    if (candidate === null || options.marker === null || candidate.boot !== options.marker) {
      throw new DaemonBootstrapError('environment', 'daemon bootstrap marker and environment do not match');
    }
    const read = options.readMetadata ?? readDaemonMetadataFile;
    const transition = options.transitionMetadata ?? transitionDaemonMetadataFile;
    const target = await exactMetadataTarget(candidate.path, options);
    const file = { ...(options.file ?? {}), runtimeDirectory: target.root };
    const metadata = await read(target.target, file);
    if (metadata.state !== 'launching' || metadata.boot_nonce !== candidate.boot) {
      throw new DaemonBootstrapError('metadata', 'daemon metadata is not the expected launching record');
    }
    if (!constantTimeSecretMatches(metadata.shutdown_secret, candidate.secret)) {
      throw new DaemonBootstrapError('secret', 'daemon bootstrap secret does not match');
    }
    const actual = options.identity ?? currentLaunchIdentity();
    if (!launchIdentityMatches({ executable: metadata.executable, entrypoint: metadata.entrypoint }, actual)) {
      throw new DaemonBootstrapError('identity', 'daemon metadata launch identity does not match the current process');
    }
    const pid = options.pid ?? process.pid;
    const starting: DaemonMetadataV1 = {
      ...metadata,
      state: 'starting',
      pid,
      instance_id: null,
      management_host: null,
      management_port: null,
    };
    await transition(candidate.path, {
      expectedBootNonce: candidate.boot,
      expectedState: 'launching',
      expectedShutdownSecret: metadata.shutdown_secret,
      next: starting,
    }, file);
    const confirmed = await read(target.target, file);
    if (confirmed.state !== 'starting' || confirmed.pid !== starting.pid
      || confirmed.boot_nonce !== candidate.boot || confirmed.shutdown_secret !== metadata.shutdown_secret) {
      throw new DaemonBootstrapError('transition', 'daemon metadata starting transition could not be confirmed');
    }
    return {
      metadataPath: target.target,
      bootNonce: candidate.boot,
      shutdownSecret: candidate.secret,
      pid,
      metadata: confirmed,
      store: {
        file,
        read,
        transition,
        deleteForMaster: options.deleteMetadata ?? deleteDaemonMetadataForMaster,
      },
    };
  } catch (error) {
    if (error instanceof DaemonBootstrapError) throw error;
    throw new DaemonBootstrapError('transition', error instanceof Error ? error.message : String(error));
  } finally {
    if (hasBootstrapEnvironment || options.marker !== null) clearDaemonBootstrapEnvironment(env as Record<string, string | undefined>);
  }
}

export const bootstrapDaemonMaster = takeOverDaemonBootstrap;
