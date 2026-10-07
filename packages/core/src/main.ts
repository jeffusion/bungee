#!/usr/bin/env bun

import dotenv from 'dotenv';
import { initializeConfigurationDatabase } from './master-runtime/initialize-configuration';
export { initializeConfigurationDatabase };
import { readAdministratorRecovery } from './master-runtime/recovery-prompt';
import { recoverOffline, readRecoveryInput } from './master-runtime/offline-recovery';
export { recoverOffline };
import { serializeErrorChain } from './master-runtime/error-chain';
import { clearDaemonBootstrapEnvironment } from './daemon-control/bootstrap';
import { parseDaemonBootMarker } from './daemon-control/launch-identity';

export interface ProcessRoleDependencies {
  startWorker(): Promise<unknown>;
  startMaster(bootNonce?: string | null): Promise<unknown>;
  startIngress?(): Promise<unknown>;
}

let activeIngressProcess: unknown;

export class ProcessRoleError extends Error {
  readonly name = 'ProcessRoleError';

  constructor(
    readonly code: 'invalid_role',
    readonly role: string,
  ) {
    super(`unsupported process role: ${JSON.stringify(role)}`);
  }
}

const PRODUCTION_DEPENDENCIES: ProcessRoleDependencies = {
  async startWorker() {
    const { startConfigWorkerProcess } = await import('./worker');
    await startConfigWorkerProcess();
  },
  async startMaster(bootNonce = null) {
    const { startMasterProcess } = await import('./master');
    if (bootNonce === null) await startMasterProcess();
    else await startMasterProcess(undefined, bootNonce);
  },
  async startIngress() {
    const { startIngressProcess } = await import('./ingress');
    activeIngressProcess = await startIngressProcess();
  },
};

export async function dispatchProcessRole(
  role: string,
  dependencies: ProcessRoleDependencies = PRODUCTION_DEPENDENCIES,
  bootNonce: string | null = null,
): Promise<void> {
  switch (role) {
    case 'worker':
      await dependencies.startWorker();
      return;
    case 'master':
      await dependencies.startMaster(bootNonce);
      return;
    case 'ingress':
      if (dependencies.startIngress === undefined) throw new ProcessRoleError('invalid_role', role);
      await dependencies.startIngress();
      return;
    default:
      throw new ProcessRoleError('invalid_role', role);
  }
}

if (import.meta.main) {
  const role = process.env.BUNGEE_ROLE ?? 'master';
  if (role === 'master') dotenv.config();
  let bootNonce: string | null = null;
  try {
    const initIndex = process.argv.indexOf('--initialize-config');
    if (process.argv[2] === 'oauth-callback') {
      if (process.argv.length !== 3) throw new Error('Invalid callback arguments');
      const { oauthCallbackCommand } = await import('./oauth-callback');
      await oauthCallbackCommand();
    } else if (process.argv.includes('--recover-admin')) {
      const args = process.argv.slice(2);
      if (args.length !== 2 || args[0] !== '--recover-admin' || !args[1]) throw new Error('invalid_recovery_arguments');
      console.log('目标配置数据库：' + args[1]);
      console.log(JSON.stringify(await recoverOffline(args[1], await readAdministratorRecovery())));
    } else if (process.argv.includes('--recover')) {
      const args = process.argv.slice(2);
      if (args.length !== 2 || args[0] !== '--recover' || !args[1]) throw new Error('invalid_recovery_arguments');
      console.log(JSON.stringify(await recoverOffline(args[1], await readRecoveryInput(process.stdin))));
    } else if (initIndex >= 0) {
      const configDbPath = process.argv[initIndex + 1];
      if (!configDbPath) throw new Error('Configuration database path is required');
      await initializeConfigurationDatabase({configDbPath});
      console.log('Configuration database initialized.');
    } else {
    const parsed = parseDaemonBootMarker(process.argv.slice(1));
    process.argv.splice(1, process.argv.length - 1, ...parsed.argv);
    bootNonce = parsed.bootNonce;
    await dispatchProcessRole(role, undefined, bootNonce);
    }
  } catch (error) {
    if (process.argv[2] === 'oauth-callback') {
      console.error('OAuth callback capture failed or was cancelled. Check the local port and restart the login.');
      process.exitCode = 1;
    } else if (process.argv.includes('--recover') || process.argv.includes('--recover-admin')) {
      console.error('Offline recovery failed; no recovery input is logged.');
      process.exitCode = 1;
    } else {
    clearDaemonBootstrapEnvironment();
    const { logger } = await import('./logger');
    logger.error({ error: serializeErrorChain(error) }, 'Process startup failed');
    process.exitCode = 1;
    }
  }
}
