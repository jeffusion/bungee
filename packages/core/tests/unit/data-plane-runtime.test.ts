import { expect, test } from 'bun:test';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { dataPlaneAccessDb, dataPlaneRuntimeRoot, dataPlaneStatsDir, ensureDataPlaneSchema } from '../helpers/data-plane-runtime';
import { accessLogWriter } from '../../src/logger/access-log-writer';

test('bootstraps data-plane singletons in an isolated database', async () => {
  await ensureDataPlaneSchema();
  const mainDatabase = (accessLogWriter.getDatabase()
    .prepare('PRAGMA database_list')
    .all() as Array<{ name: string; file: string }>)
    .find((database) => database.name === 'main');

  expect(mainDatabase?.file).toBe(await realpath(dataPlaneAccessDb));
  expect(accessLogWriter.getDatabase()
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'access_logs'")
    .get()).toEqual({ name: 'access_logs' });
  expect(process.env.BUNGEE_ACCESS_DB_PATH).not.toBe(dataPlaneAccessDb);
  expect(process.env.DATA_DIR).not.toBe(dataPlaneStatsDir);
  expect(existsSync(dataPlaneStatsDir)).toBe(false);
  expect(await Bun.file(path.join(dataPlaneRuntimeRoot, 'cumulative.json')).exists()).toBe(false);
  expect(dataPlaneRuntimeRoot).toBe(path.dirname(dataPlaneAccessDb));
});
