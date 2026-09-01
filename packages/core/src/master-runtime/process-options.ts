import { resolve } from 'node:path';

export const MASTER_PROCESS_ENV_NAMES = {
  configDbPath: 'BUNGEE_CONFIG_DB_PATH',
  workerCount: 'WORKER_COUNT',
  host: 'HOST',
  port: 'PORT',
  startupApplyTimeoutMs: 'BUNGEE_STARTUP_APPLY_TIMEOUT_MS',
  drainTimeoutMs: 'BUNGEE_DRAIN_TIMEOUT_MS',
  heartbeatIntervalMs: 'BUNGEE_HEARTBEAT_INTERVAL_MS',
  heartbeatTimeoutMs: 'BUNGEE_HEARTBEAT_TIMEOUT_MS',
  shutdownTimeoutMs: 'BUNGEE_SHUTDOWN_TIMEOUT_MS',
} as const;

const DEFAULTS = {
  configDbPath: 'data/bungee.db',
  workerCount: 2,
  host: '0.0.0.0',
  port: 8088,
  startupApplyTimeoutMs: 30_000,
  drainTimeoutMs: 30_000,
  heartbeatIntervalMs: 1_000,
  heartbeatTimeoutMs: 5_000,
  shutdownTimeoutMs: 5_000,
} as const;

export type MasterProcessOptionsErrorCode =
  | 'invalid_environment'
  | 'invalid_worker_entry';

export class MasterProcessOptionsError extends Error {
  readonly name = 'MasterProcessOptionsError';

  constructor(
    readonly code: MasterProcessOptionsErrorCode,
    readonly variable: string,
    message: string,
  ) {
    super(message);
  }
}

export type MasterProcessAccessors = {
  readonly env: (name: string) => string | undefined;
  readonly cwd: () => string;
};

export type MasterProcessOptions = {
  readonly configDbPath: string;
  readonly configDbLockPath: string;
  readonly workerCount: number;
  readonly host: string;
  readonly port: number;
  readonly startupApplyTimeoutMs: number;
  readonly drainTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
};

export type WorkerLaunchSource = 'source' | 'dist' | 'compiled';

export type WorkerLaunchInput = {
  readonly executable: string;
  readonly entry: string;
};

export type WorkerLaunch = {
  readonly source: WorkerLaunchSource;
  readonly executable: string;
  readonly args: readonly string[];
};

const PROCESS_ACCESSORS: MasterProcessAccessors = Object.freeze({
  env(name: string): string | undefined {
    return process.env[name];
  },
  cwd(): string {
    return process.cwd();
  },
});

function invalidEnvironment(variable: string, requirement: string): never {
  throw new MasterProcessOptionsError(
    'invalid_environment',
    variable,
    `${variable} ${requirement}`,
  );
}

function integer(
  value: string | undefined,
  variable: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    return invalidEnvironment(variable, 'must be a decimal integer');
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    return invalidEnvironment(variable, `must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function host(value: string | undefined): string {
  if (value === undefined) return DEFAULTS.host;
  if (value.length === 0 || value.trim() !== value) {
    return invalidEnvironment(MASTER_PROCESS_ENV_NAMES.host, 'must be a non-empty unpadded string');
  }
  return value;
}

function databasePath(value: string | undefined, cwd: string): string {
  const candidate = value ?? DEFAULTS.configDbPath;
  if (candidate.length === 0 || candidate.trim() !== candidate) {
    return invalidEnvironment(
      MASTER_PROCESS_ENV_NAMES.configDbPath,
      'must be a non-empty unpadded path',
    );
  }
  return resolve(cwd, candidate);
}

export function readMasterProcessOptions(
  accessors: MasterProcessAccessors = PROCESS_ACCESSORS,
): MasterProcessOptions {
  const env = accessors.env;
  const configDbPath = databasePath(env(MASTER_PROCESS_ENV_NAMES.configDbPath), accessors.cwd());
  const options: MasterProcessOptions = {
    configDbPath,
    configDbLockPath: `${configDbPath}.lock`,
    workerCount: integer(
      env(MASTER_PROCESS_ENV_NAMES.workerCount),
      MASTER_PROCESS_ENV_NAMES.workerCount,
      DEFAULTS.workerCount,
      1,
      64,
    ),
    host: host(env(MASTER_PROCESS_ENV_NAMES.host)),
    port: integer(
      env(MASTER_PROCESS_ENV_NAMES.port),
      MASTER_PROCESS_ENV_NAMES.port,
      DEFAULTS.port,
      1,
      65_535,
    ),
    startupApplyTimeoutMs: integer(
      env(MASTER_PROCESS_ENV_NAMES.startupApplyTimeoutMs),
      MASTER_PROCESS_ENV_NAMES.startupApplyTimeoutMs,
      DEFAULTS.startupApplyTimeoutMs,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    drainTimeoutMs: integer(
      env(MASTER_PROCESS_ENV_NAMES.drainTimeoutMs),
      MASTER_PROCESS_ENV_NAMES.drainTimeoutMs,
      DEFAULTS.drainTimeoutMs,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    heartbeatIntervalMs: integer(
      env(MASTER_PROCESS_ENV_NAMES.heartbeatIntervalMs),
      MASTER_PROCESS_ENV_NAMES.heartbeatIntervalMs,
      DEFAULTS.heartbeatIntervalMs,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    heartbeatTimeoutMs: integer(
      env(MASTER_PROCESS_ENV_NAMES.heartbeatTimeoutMs),
      MASTER_PROCESS_ENV_NAMES.heartbeatTimeoutMs,
      DEFAULTS.heartbeatTimeoutMs,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    shutdownTimeoutMs: integer(
      env(MASTER_PROCESS_ENV_NAMES.shutdownTimeoutMs),
      MASTER_PROCESS_ENV_NAMES.shutdownTimeoutMs,
      DEFAULTS.shutdownTimeoutMs,
      1,
      Number.MAX_SAFE_INTEGER,
    ),
  };
  if (options.heartbeatTimeoutMs <= options.heartbeatIntervalMs) {
    invalidEnvironment(
      MASTER_PROCESS_ENV_NAMES.heartbeatTimeoutMs,
      `must exceed ${MASTER_PROCESS_ENV_NAMES.heartbeatIntervalMs}`,
    );
  }
  return Object.freeze(options);
}

export function parseMasterProcessOptions(
  env: Readonly<Record<string, string | undefined>>,
  cwd: string,
): MasterProcessOptions {
  return readMasterProcessOptions({ env: (name) => env[name], cwd: () => cwd });
}

export function resolveWorkerLaunch(input: WorkerLaunchInput): WorkerLaunch {
  if (input.executable.length === 0) {
    throw new MasterProcessOptionsError(
      'invalid_worker_entry',
      'executable',
      'worker executable must not be empty',
    );
  }
  const portableEntry = input.entry.replaceAll('\\', '/');
  if (
    resolve(input.entry) === resolve(input.executable)
    || portableEntry.startsWith('/$bunfs/root/')
    || /^[A-Za-z]:\/~BUN\/root\//.test(portableEntry)
  ) {
    return Object.freeze({
      source: 'compiled',
      executable: input.executable,
      args: Object.freeze([]),
    });
  }

  const source = portableEntry === 'src/main.ts' || portableEntry.endsWith('/src/main.ts')
    ? 'source'
    : portableEntry === 'dist/main.js' || portableEntry.endsWith('/dist/main.js')
      ? 'dist'
      : null;
  if (source === null) {
    throw new MasterProcessOptionsError(
      'invalid_worker_entry',
      'entry',
      `worker entry must be src/main.ts, dist/main.js, or the current executable: ${input.entry}`,
    );
  }
  return Object.freeze({
    source,
    executable: input.executable,
    args: Object.freeze([input.entry]),
  });
}
