import { expect, test } from 'bun:test';
import type { AppConfig } from '@jeffusion/bungee-types';
import type { BodyStorageManager } from '../../../src/logger/body-storage';
import { createDataPlaneRuntime } from '../../helpers/data-plane-runtime';
const config: AppConfig = { config_version: 4, routes: [] };
  test('disables body storage when a later production config removes logging.body', async () => {
    const runtime = await createDataPlaneRuntime();
    const { loadProductionResources } = await import('../../../src/config-worker/lifecycle');
    try {
    const resources = await loadProductionResources();
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
    await resources.closeAccessLog();
    await resources.closeFileLog();
    } finally { await runtime.close(); }
  });
