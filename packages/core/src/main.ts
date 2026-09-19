#!/usr/bin/env bun

import dotenv from 'dotenv';
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
    const parsed = parseDaemonBootMarker(process.argv.slice(1));
    process.argv.splice(1, process.argv.length - 1, ...parsed.argv);
    bootNonce = parsed.bootNonce;
    await dispatchProcessRole(role, undefined, bootNonce);
  } catch (error) {
    clearDaemonBootstrapEnvironment();
    const { logger } = await import('./logger');
    logger.error({ error: serializeErrorChain(error) }, 'Process startup failed');
    process.exitCode = 1;
  }
}
