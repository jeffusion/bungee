import { describe, expect, test } from 'bun:test';

const MASTER_PATH = new URL('../../../src/master.ts', import.meta.url);
const MAIN_PATH = new URL('../../../src/main.ts', import.meta.url);

describe('production master contract', () => {
  test('uses one explicit master composition with no legacy runtime', async () => {
    const source = await Bun.file(MASTER_PATH).text();

    expect(source).toContain('export async function startMasterProcess');
    for (const legacy of [
      'class Master', 'CONFIG_PATH', 'fs.watch', 'SIGUSR2',
      'forkWorker', 'gracefulReload', 'loadConfig', 'reusePort',
      'PluginStorageCleanupService',
      'initializePermissionManager', 'PluginRuntimeMultiWorkerCoordinator',
    ]) {
      expect(source).not.toContain(legacy);
    }
    expect(source).toContain('migrateAccessDatabaseAsync(path, resolveObservabilityWorkerUrl(import.meta.url))');
    expect(source).toContain('createAsyncMasterStats(path');
    expect(source).toContain('AsyncConfigRepository.open(path');
    expect(source).not.toContain('new MigrationManager');
    expect(source).not.toContain('new Database');
    expect(source).not.toContain("'bun:sqlite'");
    const observationLeaf = await Bun.file(new URL('../../../src/master-runtime/observability-worker.ts',import.meta.url)).text();
    expect(observationLeaf).toContain('new MigrationManager(args[0]).migrate()');
  });

  test('keeps main as the sole awaited role dispatcher', async () => {
    const source = await Bun.file(MAIN_PATH).text();

    expect(source).not.toContain('preloadGlobalConfig');
    expect(source).toContain('await startConfigWorkerProcess()');
    expect(source).toContain('await startMasterProcess()');
  });
});
