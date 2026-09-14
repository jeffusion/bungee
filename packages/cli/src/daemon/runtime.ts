import { isAbsolute, join } from 'node:path';

export type DaemonRuntimeOptions = {
  readonly dataDirectory: string;
  readonly logsDirectory: string;
  readonly workers?: string;
  readonly port?: string;
  readonly inheritedEnvironment?: Readonly<Record<string, string | undefined>>;
};

export type DaemonRuntime = {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
};

export function createDaemonRuntime(options: DaemonRuntimeOptions): DaemonRuntime {
  if (!isAbsolute(options.dataDirectory)) throw new Error('Daemon data directory must be absolute');
  const stripped = new Set([
    'config_path', 'plugins_dir', 'bungee_daemon_metadata_path', 'bungee_daemon_boot_nonce',
    'bungee_daemon_shutdown_secret', 'bungee_role',
  ]);
  const inheritedEnvironment = Object.fromEntries(
    Object.entries(options.inheritedEnvironment ?? {}).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !stripped.has(entry[0].toLowerCase()),
    ),
  );
  return {
    cwd: options.dataDirectory,
    env: {
      ...inheritedEnvironment,
      BUNGEE_CONFIG_DB_PATH: join(options.dataDirectory, 'bungee.db'),
      BUNGEE_ACCESS_DB_PATH: join(options.logsDirectory, 'access.db'),
      WORKER_COUNT: options.workers ?? '2',
      DAEMON_MODE: 'true',
      ...(options.port === undefined ? {} : { PORT: options.port }),
    },
  };
}
