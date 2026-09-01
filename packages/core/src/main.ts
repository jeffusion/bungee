#!/usr/bin/env bun

import dotenv from 'dotenv';

export interface ProcessRoleDependencies {
  startWorker(): Promise<unknown>;
  startMaster(): Promise<unknown>;
}

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
    default:
      throw new ProcessRoleError('invalid_role', role);
  }
}

if (import.meta.main) {
  dotenv.config();
  try {
    await dispatchProcessRole(process.env.BUNGEE_ROLE ?? 'master');
  } catch (error) {
    const { logger } = await import('./logger');
    logger.error({ error }, 'Process startup failed');
    process.exitCode = 1;
  }
}
