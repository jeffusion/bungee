import { expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { BodyStorageManager } from '../../../src/logger/body-storage';
import type { PluginRegistry } from '../../../src/plugin-registry';
import { createDataPlaneRuntime } from '../../helpers/data-plane-runtime';
import requestLogsManifest from '../../../../../plugins/request-logs/manifest.json';

const config: AppConfig = { config_version: 4, routes: [] };

test('disables body storage when a later production config removes logging.body', async () => {
  const runtime = await createDataPlaneRuntime();
  const { getPluginRegistry, setPluginRegistry } = await import('../../../src/worker/state/plugin-manager');
  const { loadProductionResources } = await import('../../../src/config-worker/lifecycle');
  const previousRegistry = getPluginRegistry();
  const environment = {
    BUNGEE_ACCESS_DB_PATH: runtime.dataPlaneAccessDb,
    BUNGEE_FILE_LOG_DIR: runtime.dataPlaneFileLogDir,
    BUNGEE_BODY_LOG_DIR: runtime.dataPlaneBodyLogDir,
    BUNGEE_HEADER_LOG_DIR: runtime.dataPlaneHeaderLogDir,
  };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const resources = await loadProductionResources();
  try {
    expect(resources.requestLogging).toBeUndefined();
    setPluginRegistry({
      getAllPluginStateSnapshots: () => new Map([
        ['request-logs', { persistedEnabled: 'enabled', manifest: requestLogsManifest }],
      ]),
    } as unknown as PluginRegistry);
    const bodyStorage = resources.requestLogging?.bodyStorage as BodyStorageManager;
    const enabledConfig: AppConfig = {
      ...config,
      logging: { body: { enabled: true, max_size: 321, retention_days: 7 } },
    };

    resources.configureBodyStorage(enabledConfig);
    expect(bodyStorage.getConfig()).toMatchObject({
      enabled: true,
      maxSize: 321,
      retentionDays: 7,
    });

    resources.configureBodyStorage(config);
    expect(bodyStorage.getConfig().enabled).toBe(false);
  } finally {
    setPluginRegistry(previousRegistry);
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await resources.closeAccessLog();
    await resources.closeFileLog();
    await runtime.close();
  }
});
