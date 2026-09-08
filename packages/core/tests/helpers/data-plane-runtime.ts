import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const dataPlaneRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bungee-data-plane-'));
export const dataPlaneTestRoot = dataPlaneRuntimeRoot;
export const dataPlaneAccessDb = path.join(dataPlaneRuntimeRoot, 'access.db');
export const dataPlaneFileLogDir = path.join(dataPlaneRuntimeRoot, 'logs');
export const dataPlaneBodyLogDir = path.join(dataPlaneRuntimeRoot, 'bodies');
export const dataPlaneHeaderLogDir = path.join(dataPlaneRuntimeRoot, 'headers');
export const dataPlaneStatsDir = path.join(dataPlaneRuntimeRoot, 'stats');

const dataPlaneEnvKeys = [
  'BUNGEE_ACCESS_DB_PATH',
  'BUNGEE_FILE_LOG_DIR',
  'BUNGEE_BODY_LOG_DIR',
  'BUNGEE_HEADER_LOG_DIR',
  'DATA_DIR',
] as const;
const originalDataPlaneEnv = Object.fromEntries(
  dataPlaneEnvKeys.map((key) => [key, process.env[key]]),
);
const dataPlaneSingletonModules: unknown[] = [];

process.once('exit', () => {
  try {
    fs.rmSync(dataPlaneRuntimeRoot, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; open SQLite handles may prevent removal on Windows.
  }
});

const dataPlaneBootstrapPromise: Promise<void> = (async () => {
  process.env.BUNGEE_ACCESS_DB_PATH = dataPlaneAccessDb;
  process.env.BUNGEE_FILE_LOG_DIR = dataPlaneFileLogDir;
  process.env.BUNGEE_BODY_LOG_DIR = dataPlaneBodyLogDir;
  process.env.BUNGEE_HEADER_LOG_DIR = dataPlaneHeaderLogDir;
  process.env.DATA_DIR = dataPlaneStatsDir;

  try {
    const { MigrationManager } = await import('../../src/migrations/migration-manager');
    const result = await new MigrationManager(dataPlaneAccessDb).migrate();
    if (!result.success) {
      throw new Error(`Data-plane schema migration failed: ${result.error ?? 'unknown error'}`);
    }

    dataPlaneSingletonModules.push(await import('../../src/logger/access-log-writer'));
    dataPlaneSingletonModules.push(await import('../../src/logger/file-log-writer'));
    dataPlaneSingletonModules.push(await import('../../src/logger/body-storage'));
    dataPlaneSingletonModules.push(await import('../../src/logger/header-storage'));
    dataPlaneSingletonModules.push(await import('../../src/api/collectors/persistent-stats-collector'));
  } finally {
    for (const key of dataPlaneEnvKeys) {
      const value = originalDataPlaneEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
})();

export function ensureDataPlaneSchema(): Promise<void> {
  return dataPlaneBootstrapPromise;
}

await dataPlaneBootstrapPromise;
