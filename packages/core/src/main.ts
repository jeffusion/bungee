#!/usr/bin/env bun

import dotenv from 'dotenv';

export interface ProcessRoleDependencies {
  startWorker(): Promise<unknown>;
  startMaster(): Promise<unknown>;
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
  async startMaster() {
    const { startMasterProcess } = await import('./master');
    await startMasterProcess();
  },
  async startIngress() {
    const { startIngressProcess } = await import('./ingress');
    activeIngressProcess = await startIngressProcess();
  },
};

export async function dispatchProcessRole(
  role: string,
  dependencies: ProcessRoleDependencies = PRODUCTION_DEPENDENCIES,
): Promise<void> {
  switch (role) {
    case 'worker':
      await dependencies.startWorker();
      return;
    case 'master':
      await dependencies.startMaster();
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
  try {
    await dispatchProcessRole(role);
  } catch (error) {
    const { logger } = await import('./logger');
    logger.error({ error }, 'Process startup failed');
    process.exitCode = 1;
  }
}
