import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readPluginSecretsKey } from '../../../src/config/plugin-secrets-key';
import { makeCanonicalTempDir } from '../../../../../tests/helpers/daemon-fixture';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

function database(): string {
  const dir = makeCanonicalTempDir('bungee-cli-init');
  directories.push(dir);
  return join(dir, 'data', 'bungee.db');
}

async function initialize(db: string, parameter?: string, environment?: string) {
  const command = pathToFileURL(fileURLToPath(new URL('../../../src/commands/init.ts', import.meta.url))).href;
  const core = fileURLToPath(new URL('../../../../core/dist/main.js', import.meta.url));
  const source = `import {initCommand} from ${JSON.stringify(command)}; await initCommand({pluginSecretsKey:process.argv[1],directLaunch:{executable:process.execPath,entrypoint:${JSON.stringify(core)}}});`;
  const env: NodeJS.ProcessEnv = { ...process.env, BUNGEE_CONFIG_DB_PATH: db, BUNGEE_ACCESS_DB_PATH: join(dirname(dirname(db)), 'logs', 'access.db'), BUNGEE_INCLUDE_SYSTEM_PLUGINS: 'false' };
  delete env.BUNGEE_PLUGIN_SECRETS_KEY;
  if (environment !== undefined) env.BUNGEE_PLUGIN_SECRETS_KEY = environment;
  const child = Bun.spawn([process.execPath, '-e', source, ...(parameter === undefined ? [] : [parameter])], { env, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr };
}

test('init persists its generated key and remains idempotent without environment configuration', async () => {
  const db = database();
  const first = await initialize(db);
  expect(first.code, first.stderr).toBe(0);
  const key = await readPluginSecretsKey(db);
  expect(first.stdout + first.stderr).not.toContain(key);
  expect(await Bun.file(db).exists()).toBe(true);
  expect(await Bun.file(join(dirname(db), 'plugin-state.db')).exists()).toBe(true);
  const second = await initialize(db);
  expect(second.code, second.stderr).toBe(0);
  expect(await readPluginSecretsKey(db)).toBe(key);
}, 30_000);

test('init persists environment input and gives the explicit parameter precedence', async () => {
  const environment = randomBytes(32).toString('base64'), parameter = randomBytes(32).toString('base64');
  const envDb = database(), parameterDb = database();
  const fromEnv = await initialize(envDb, undefined, environment);
  expect(fromEnv.code, fromEnv.stderr).toBe(0);
  expect(await readPluginSecretsKey(envDb)).toBe(environment);
  const fromParameter = await initialize(parameterDb, parameter, environment);
  expect(fromParameter.code, fromParameter.stderr).toBe(0);
  expect(await readPluginSecretsKey(parameterDb)).toBe(parameter);
  expect(fromParameter.stdout + fromParameter.stderr).not.toContain(parameter);
  const conflict = await initialize(parameterDb, undefined, environment);
  expect(conflict.code).toBe(1);
  expect(conflict.stdout + conflict.stderr).not.toContain(environment);
  expect(await readPluginSecretsKey(parameterDb)).toBe(parameter);
}, 30_000);
