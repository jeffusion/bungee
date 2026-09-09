import { expect, test } from 'bun:test';
import path from 'node:path';
import { dataPlaneAccessDb, dataPlaneRuntimeRoot, dataPlaneStatsDir, ensureDataPlaneSchema } from '../helpers/data-plane-runtime';
import { accessLogWriter } from '../../src/logger/access-log-writer';
import { STORAGE_CONFIG } from '../../src/api/constants';
import { fileStorageManager } from '../../src/api/utils/file-storage';

test('bootstraps data-plane singletons in an isolated database', async () => {
  await ensureDataPlaneSchema();
  const mainDatabase = (accessLogWriter.getDatabase()
    .prepare('PRAGMA database_list')
    .all() as Array<{ name: string; file: string }>)
    .find((database) => database.name === 'main');

  expect(mainDatabase?.file).toBe(dataPlaneAccessDb);
  expect(accessLogWriter.getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_logs'")
    .get()).toEqual({ name: 'access_logs' });
  expect(process.env.BUNGEE_ACCESS_DB_PATH).not.toBe(dataPlaneAccessDb);
  expect(process.env.DATA_DIR).not.toBe(dataPlaneStatsDir);
  expect(STORAGE_CONFIG.dataDir).toBe(dataPlaneStatsDir);
  expect(await fileStorageManager.writeSlot('isolation_contract', {} as never)).toBe(true);
  expect(await Bun.file(path.join(dataPlaneStatsDir, 'isolation_contract.json')).exists()).toBe(true);
  expect(dataPlaneRuntimeRoot).toBe(path.dirname(dataPlaneAccessDb));
});
