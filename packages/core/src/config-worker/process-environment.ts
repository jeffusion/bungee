import { isLowercaseUuid } from '../config-storage/validation';
import { isAbsolute, normalize } from 'node:path';
import type { ConfigProcessIdentity } from '../config-publication/types';
import { parseWorkerTransportSecret } from './private-transport';
import { importWorkerSupervisionSeed, type WorkerSupervisionSeed } from '../supervision';

export type SupervisedWorkerRateLimitSession = {
  readonly supervisionPort: number;
  readonly expectedIngress: {
    readonly process_instance_id: string;
    readonly boot_nonce: string;
  };
};

export const CONFIG_WORKER_ENV_NAMES = {
  masterGeneration: 'BUNGEE_MASTER_GENERATION',
  workerInstanceId: 'BUNGEE_WORKER_INSTANCE_ID',
  workerSlot: 'BUNGEE_WORKER_SLOT',
  transportSecret: 'BUNGEE_INTERNAL_TRANSPORT_SECRET',
  accessLogDbPath: 'BUNGEE_ACCESS_DB_PATH',
  supervisionSeed: 'BUNGEE_WORKER_SUPERVISION_SEED',
  controlPort: 'BUNGEE_WORKER_CONTROL_PORT',
  managementHost: 'BUNGEE_MANAGEMENT_HOST',
  managementPort: 'BUNGEE_MANAGEMENT_PORT',
  descriptorPath: 'BUNGEE_WORKER_DESCRIPTOR_PATH',
  startupWatchdogMs: 'BUNGEE_WORKER_STARTUP_WATCHDOG_MS',
  attachGraceMs: 'BUNGEE_WORKER_ATTACH_GRACE_MS',
  ingressSupervisionPort: 'BUNGEE_INGRESS_SUPERVISION_PORT',
  ingressProcessInstanceId: 'BUNGEE_INGRESS_PROCESS_INSTANCE_ID',
  ingressBootNonce: 'BUNGEE_INGRESS_BOOT_NONCE',
} as const;

export type SupervisedWorkerEnvironment = {
  readonly identity: ConfigProcessIdentity;
  readonly transportSecret: string;
  readonly accessLogDbPath: string;
  readonly supervisionSeed: WorkerSupervisionSeed;
  readonly controlPort: number;
  readonly managementHost: '127.0.0.1' | '::1';
  readonly managementPort: number;
  readonly descriptorPath: string;
  readonly startupWatchdogMs: number;
  readonly attachGraceMs: number;
  readonly rateLimitSession?: SupervisedWorkerRateLimitSession;
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

function rateLimitSession(env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>): SupervisedWorkerRateLimitSession | undefined {
  const names = [
    CONFIG_WORKER_ENV_NAMES.ingressSupervisionPort,
    CONFIG_WORKER_ENV_NAMES.ingressProcessInstanceId,
    CONFIG_WORKER_ENV_NAMES.ingressBootNonce,
  ] as const;
  const values = names.map((name) => env[name]);
  if (values.every((value) => value === undefined || value === '')) return undefined;
  if (values.some((value) => value === undefined || value === '')) throw new Error('rate-limit ingress session must be complete');
  const [portValue, processInstanceId, bootNonce] = values as [string, string, string];
  const supervisionPort = integer(portValue, CONFIG_WORKER_ENV_NAMES.ingressSupervisionPort, 1);
  if (supervisionPort > 65_535) throw new Error(`${CONFIG_WORKER_ENV_NAMES.ingressSupervisionPort} must be a safe integer <= 65535`);
  if (!isLowercaseUuid(processInstanceId)) throw new Error(`${CONFIG_WORKER_ENV_NAMES.ingressProcessInstanceId} must be a lowercase UUID`);
  if (!isLowercaseUuid(bootNonce)) throw new Error(`${CONFIG_WORKER_ENV_NAMES.ingressBootNonce} must be a lowercase UUID`);
  return { supervisionPort, expectedIngress: { process_instance_id: processInstanceId, boot_nonce: bootNonce } };
}

export function parseSupervisedWorkerEnvironment(
  env: NodeJS.ProcessEnv | Readonly<Record<string, string | undefined>>,
): SupervisedWorkerEnvironment {
  const masterGeneration = required(env, CONFIG_WORKER_ENV_NAMES.masterGeneration);
  const workerInstanceId = required(env, CONFIG_WORKER_ENV_NAMES.workerInstanceId);
  const workerSlot = integer(required(env, CONFIG_WORKER_ENV_NAMES.workerSlot), CONFIG_WORKER_ENV_NAMES.workerSlot, 0);
  if (!isLowercaseUuid(masterGeneration)) throw new Error(`${CONFIG_WORKER_ENV_NAMES.masterGeneration} must be a lowercase UUID`);
  if (!isLowercaseUuid(workerInstanceId)) throw new Error(`${CONFIG_WORKER_ENV_NAMES.workerInstanceId} must be a lowercase UUID`);
  const accessLogDbPath = required(env, CONFIG_WORKER_ENV_NAMES.accessLogDbPath);
  if (!isAbsolute(accessLogDbPath) || normalize(accessLogDbPath) !== accessLogDbPath) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.accessLogDbPath} must be a normalized absolute path`);
  }
  let transportSecret: string;
  try { transportSecret = parseWorkerTransportSecret(required(env, CONFIG_WORKER_ENV_NAMES.transportSecret)); }
  catch { throw new Error(`${CONFIG_WORKER_ENV_NAMES.transportSecret} must be canonical 32-byte base64url`); }
  let supervisionSeed: WorkerSupervisionSeed;
  try { supervisionSeed = importWorkerSupervisionSeed(required(env, CONFIG_WORKER_ENV_NAMES.supervisionSeed)); }
  catch { throw new Error(`${CONFIG_WORKER_ENV_NAMES.supervisionSeed} must be a valid worker supervision seed`); }
  if (supervisionSeed.master_generation !== masterGeneration || supervisionSeed.worker_instance_id !== workerInstanceId
    || supervisionSeed.worker_slot !== workerSlot) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.supervisionSeed} is bound to another worker identity`);
  }
  const managementHost = required(env, CONFIG_WORKER_ENV_NAMES.managementHost);
  if (managementHost !== '127.0.0.1' && managementHost !== '::1') {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.managementHost} must be 127.0.0.1 or ::1`);
  }
  const descriptorPathValue = required(env, CONFIG_WORKER_ENV_NAMES.descriptorPath);
  if (!isAbsolute(descriptorPathValue) || normalize(descriptorPathValue) !== descriptorPathValue) {
    throw new Error(`${CONFIG_WORKER_ENV_NAMES.descriptorPath} must be a normalized absolute path`);
  }
  const managementPort = integer(required(env, CONFIG_WORKER_ENV_NAMES.managementPort), CONFIG_WORKER_ENV_NAMES.managementPort, 1);
  if (managementPort > 65_535) throw new Error(`${CONFIG_WORKER_ENV_NAMES.managementPort} must be a safe integer <= 65535`);
  const controlPort = integer(required(env, CONFIG_WORKER_ENV_NAMES.controlPort), CONFIG_WORKER_ENV_NAMES.controlPort, 0);
  if (controlPort > 65_535) throw new Error(`${CONFIG_WORKER_ENV_NAMES.controlPort} must be a safe integer <= 65535`);
  const session = rateLimitSession(env);
  return {
    identity: { master_generation: masterGeneration, worker_instance_id: workerInstanceId, worker_slot: workerSlot },
    transportSecret,
    accessLogDbPath,
    supervisionSeed,
    controlPort,
    managementHost,
    managementPort,
    descriptorPath: descriptorPathValue,
    startupWatchdogMs: integer(required(env, CONFIG_WORKER_ENV_NAMES.startupWatchdogMs), CONFIG_WORKER_ENV_NAMES.startupWatchdogMs, 1),
    attachGraceMs: integer(required(env, CONFIG_WORKER_ENV_NAMES.attachGraceMs), CONFIG_WORKER_ENV_NAMES.attachGraceMs, 1),
    ...(session === undefined ? {} : { rateLimitSession: session }),
  };
}
