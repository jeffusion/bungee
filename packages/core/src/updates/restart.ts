import { randomBytes, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createLaunchingDaemonMetadataFile, deleteDaemonMetadataForLauncher } from '@jeffusion/bungee-types/daemon-file';
import { encodeDaemonShutdownSecret, type DaemonMetadataV1 } from '@jeffusion/bungee-types';
import type { DaemonBootstrap } from '../daemon-control/bootstrap';
import type { MasterProcessHandle } from '../master-runtime/composition';
import { MASTER_PROCESS_ENV_NAMES, type MasterProcessOptions } from '../master-runtime/process-options';
import { UpdateStore } from './installation';
import { UpdateError } from './release';

export async function replaceMaster(input: {
  handle: MasterProcessHandle; bootstrap: DaemonBootstrap | null; options: MasterProcessOptions;
  root: string; accessDbPath: string; activate(): string; token: string; signal: AbortSignal;
}): Promise<void> {
  if (typeof process.execve !== 'function' || !input.handle.shutdownForUpdate) throw new UpdateError('unsupported_platform');
  const environment: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => entry[1] !== undefined));
  for (const [key, variable] of Object.entries(MASTER_PROCESS_ENV_NAMES)) {
    const value = input.options[key as keyof MasterProcessOptions];
    if (value !== undefined) environment[variable] = String(value);
  }
  environment.BUNGEE_INSTALL_ROOT = input.root;
  environment.BUNGEE_ACCESS_DB_PATH = input.accessDbPath;
  environment.BUNGEE_UPDATE_TOKEN = input.token;
  environment.BUNGEE_ROLE = 'master';
  await input.handle.shutdownForUpdate();
  input.signal.throwIfAborted();
  const executable = input.activate();
  const store = new UpdateStore(input.root);
  const nonce = randomUUID();
  const args = [executable, `--bungee-process-identity=${nonce}`];
  let metadata: DaemonMetadataV1 | null = null;
  try {
    if (input.bootstrap) {
      const secret = encodeDaemonShutdownSecret(randomBytes(32));
      metadata = { schema: 'bungee-daemon-metadata-v1', state: 'launching', launcher_pid: process.pid,
        boot_nonce: nonce, executable, shutdown_secret: secret, entrypoint: null, pid: null, instance_id: null,
        management_host: null, management_port: null };
      await createLaunchingDaemonMetadataFile(input.bootstrap.metadataPath, metadata, {
        ...input.bootstrap.store.file, runtimeDirectory: dirname(input.bootstrap.metadataPath),
      });
      environment.BUNGEE_DAEMON_METADATA_PATH = input.bootstrap.metadataPath;
      environment.BUNGEE_DAEMON_BOOT_NONCE = nonce;
      environment.BUNGEE_DAEMON_SHUTDOWN_SECRET = secret;
      args.push(`--bungee-daemon-boot=${nonce}`);
    }
    input.signal.throwIfAborted();
    if (store.stopRequested(input.token)) throw new UpdateError('update_cancelled');
    process.execve(executable, args, environment);
  } catch (error) {
    if (metadata && input.bootstrap) await deleteDaemonMetadataForLauncher(input.bootstrap.metadataPath, {
      bootNonce: nonce, shutdownSecret: metadata.shutdown_secret,
    }, input.bootstrap.store.file);
    throw error;
  }
}
