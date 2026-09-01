import { describe, expect, test } from 'bun:test';

const MASTER_PATH = new URL('../../src/master.ts', import.meta.url);
const MAIN_PATH = new URL('../../src/main.ts', import.meta.url);

describe('production master contract', () => {
  test('uses one explicit master composition with no legacy runtime', async () => {
    const source = await Bun.file(MASTER_PATH).text();

    expect(source).toContain('export async function startMasterProcess');
    for (const legacy of [
      'class Master', 'CONFIG_PATH', 'fs.watch', 'SIGUSR2',
      'forkWorker', 'gracefulReload', 'loadConfig', 'reusePort',
      'PluginStorageCleanupService', 'logCleanupService',
      'initializePermissionManager', 'PluginRuntimeMultiWorkerCoordinator',
    ]) {
      expect(source).not.toContain(legacy);
    }
    expect(source).toContain('new MigrationManager(path).migrate()');
  });

  test('keeps main as the sole awaited role dispatcher', async () => {
    const source = await Bun.file(MAIN_PATH).text();

    expect(source).not.toContain('preloadGlobalConfig');
    expect(source).toContain('await startConfigWorkerProcess()');
    expect(source).toContain('await startMasterProcess()');
  });
});
