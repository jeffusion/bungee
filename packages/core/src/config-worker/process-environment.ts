import { isLowercaseUuid } from '../config-storage/validation';
import { isAbsolute, normalize } from 'node:path';
import type { ConfigProcessIdentity } from '../config-publication/types';
import { parseWorkerTransportSecret } from './private-transport';

export const CONFIG_WORKER_ENV_NAMES = {
  masterGeneration: 'BUNGEE_MASTER_GENERATION',
  workerInstanceId: 'BUNGEE_WORKER_INSTANCE_ID',
  workerSlot: 'BUNGEE_WORKER_SLOT',
  masterPid: 'BUNGEE_MASTER_PID',
  heartbeatTimeoutMs: 'BUNGEE_HEARTBEAT_TIMEOUT_MS',
  shutdownTimeoutMs: 'BUNGEE_SHUTDOWN_TIMEOUT_MS',
  transportSecret: 'BUNGEE_INTERNAL_TRANSPORT_SECRET',
  accessLogDbPath: 'BUNGEE_ACCESS_DB_PATH',
} as const;

export type ConfigWorkerEnvironment = {
  readonly identity: ConfigProcessIdentity;
  readonly masterPid: number;
  readonly heartbeatTimeoutMs: number;
  readonly shutdownTimeoutMs: number;
  readonly transportSecret: string;
  readonly accessLogDbPath: string;
};

function required(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is required`);
  return value;
}

function integer(value: string, name: string, minimum: number): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error(`${name} must be a decimal integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum) {
    throw new Error(`${name} must be a safe integer >= ${minimum}`);
  }
  return parsed;
}

export function parseConfigWorkerEnvironment(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): ConfigWorkerEnvironment {
  const masterGeneration = required(env, CONFIG_WORKER_ENV_NAMES.masterGeneration);
  const workerInstanceId = required(env, CONFIG_WORKER_ENV_NAMES.workerInstanceId);
  if (!isLowercaseUuid(masterGeneration)) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.masterGeneration} must be a lowercase UUID`);
  }
  if (!isLowercaseUuid(workerInstanceId)) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.workerInstanceId} must be a lowercase UUID`);
  }
  const transportSecretName = CONFIG_WORKER_ENV_NAMES.transportSecret;
  const accessLogDbPath = required(env, CONFIG_WORKER_ENV_NAMES.accessLogDbPath);
  if (!isAbsolute(accessLogDbPath) || normalize(accessLogDbPath) !== accessLogDbPath) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.accessLogDbPath} must be a normalized absolute path`);
  }
  let transportSecret: string;
  try {
    transportSecret = parseWorkerTransportSecret(required(env, transportSecretName));
  } catch {
    throw new Error(`${transportSecretName} must be canonical 32-byte base64url`);
  }
  return {
    identity: {
      master_generation: masterGeneration,
      worker_instance_id: workerInstanceId,
      worker_slot: integer(required(env, CONFIG_WORKER_ENV_NAMES.workerSlot), CONFIG_WORKER_ENV_NAMES.workerSlot, 0),
    },
    masterPid: integer(required(env, CONFIG_WORKER_ENV_NAMES.masterPid), CONFIG_WORKER_ENV_NAMES.masterPid, 1),
    heartbeatTimeoutMs: integer(
      required(env, CONFIG_WORKER_ENV_NAMES.heartbeatTimeoutMs),
      CONFIG_WORKER_ENV_NAMES.heartbeatTimeoutMs,
      1,
    ),
    shutdownTimeoutMs: integer(
      required(env, CONFIG_WORKER_ENV_NAMES.shutdownTimeoutMs),
      CONFIG_WORKER_ENV_NAMES.shutdownTimeoutMs,
      1,
    ),
    transportSecret,
    accessLogDbPath,
  };
}
