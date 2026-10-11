import fs from 'node:fs/promises';
import path from 'node:path';
import { makeCanonicalTempDir } from '../../../../tests/helpers/canonical-temp';

/** Call before importing request/logging modules, which capture their default paths. */
export async function createDataPlaneRuntime() {
  const dataPlaneRuntimeRoot = makeCanonicalTempDir('bungee-data-plane');
  const paths = {
    dataPlaneRuntimeRoot,
    dataPlaneTestRoot: dataPlaneRuntimeRoot,
    dataPlaneAccessDb: path.join(dataPlaneRuntimeRoot, 'access.db'),
    dataPlaneFileLogDir: path.join(dataPlaneRuntimeRoot, 'logs'),
    dataPlaneBodyLogDir: path.join(dataPlaneRuntimeRoot, 'bodies'),
    dataPlaneHeaderLogDir: path.join(dataPlaneRuntimeRoot, 'headers'),
    dataPlaneStatsDir: path.join(dataPlaneRuntimeRoot, 'stats'),
  };
  const environment = {
    BUNGEE_ACCESS_DB_PATH: paths.dataPlaneAccessDb,
    BUNGEE_FILE_LOG_DIR: paths.dataPlaneFileLogDir,
    BUNGEE_BODY_LOG_DIR: paths.dataPlaneBodyLogDir,
    BUNGEE_HEADER_LOG_DIR: paths.dataPlaneHeaderLogDir,
    DATA_DIR: paths.dataPlaneStatsDir,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  const cleanup: Array<() => Promise<unknown>> = [];
  let closed = false;
  async function close() {
    if (closed) return;
    closed = true;
    const errors: unknown[] = [];
    for (const release of cleanup) {
      try { await release(); } catch (error) { errors.push(error); }
    }
    try { await fs.rm(dataPlaneRuntimeRoot, { recursive: true, force: true }); }
    catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Data-plane fixture cleanup failed');
  }
  try {
    Object.assign(process.env, environment);
    const { MigrationManager } = await import('../../src/migrations/migration-manager');
    const result = await new MigrationManager(paths.dataPlaneAccessDb).migrate();
    if (!result.success) throw new Error(`Data-plane schema migration failed: ${result.error ?? 'unknown error'}`);
    const { accessLogWriter } = await import('../../src/logger/access-log-writer');
    cleanup.push(() => accessLogWriter.close());
    const { fileLogWriter } = await import('../../src/logger/file-log-writer');
    cleanup.push(() => fileLogWriter.close());
    await import('../../src/logger/body-storage');
    await import('../../src/logger/header-storage');
    const { flushBodyCaptures } = await import('../../src/logger/body-capture');
    cleanup.unshift(() => flushBodyCaptures());
    return {
      ...paths,
      close,
    };
  } catch (error) {
    try { await close(); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Data-plane fixture initialization failed'); }
    throw error;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}
