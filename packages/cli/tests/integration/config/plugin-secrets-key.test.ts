import { afterEach, expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { initializePluginSecretsKey, pluginSecretsKeyPath, readPluginSecretsKey } from '../../../src/config/plugin-secrets-key';
import { makeCanonicalTempDir } from '../../../../../tests/helpers/daemon-fixture';

const directories: string[] = [];
function database(): string {
  const dir = makeCanonicalTempDir('bungee-secrets-key');
  directories.push(dir);
  return join(dir, 'data', 'bungee.db');
}
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

test('init generates a valid private key once and subsequent reads preserve it', async () => {
  const db = database();
  const key = await initializePluginSecretsKey(db);
  expect(Buffer.from(key, 'base64').length).toBe(32);
  expect(await readFile(pluginSecretsKeyPath(db), 'utf8')).toBe(key);
  expect(await initializePluginSecretsKey(db)).toBe(key);
  expect(await initializePluginSecretsKey(db, key)).toBe(key);
  expect(await readPluginSecretsKey(db)).toBe(key);
  if (process.platform !== 'win32') expect((await lstat(pluginSecretsKeyPath(db))).mode & 0o777).toBe(0o600);
});

test('explicit initialization persists the supplied key and rejects replacement without writing', async () => {
  const db = database(), key = randomBytes(32).toString('base64');
  expect(await initializePluginSecretsKey(db, key)).toBe(key);
  await expect(initializePluginSecretsKey(db, randomBytes(32).toString('base64'))).rejects.toThrow('already initialized');
  expect(await readPluginSecretsKey(db)).toBe(key);
});

test.each(['', 'invalid', Buffer.alloc(31).toString('base64'), Buffer.alloc(33).toString('base64'), Buffer.alloc(32).toString('base64') + '\n'])('invalid input does not create a key file', async key => {
  const db = database();
  await expect(initializePluginSecretsKey(db, key)).rejects.toThrow('canonical Base64');
  expect(await Bun.file(pluginSecretsKeyPath(db)).exists()).toBe(false);
});

test('runtime reads fail without init and never generate a replacement for a damaged key', async () => {
  const db = database();
  await expect(readPluginSecretsKey(db)).rejects.toThrow('Run bungee init');
  await initializePluginSecretsKey(db);
  await writeFile(pluginSecretsKeyPath(db), 'damaged');
  await expect(readPluginSecretsKey(db)).rejects.toThrow();
  await expect(initializePluginSecretsKey(db)).rejects.toThrow();
  expect(await readFile(pluginSecretsKeyPath(db), 'utf8')).toBe('damaged');
});

test.each(['bungee.db', 'plugin-state.db'])('existing %s requires the original key instead of generating a new one', async existing => {
  const db = database();
  await mkdir(dirname(db), { recursive: true });
  await writeFile(join(dirname(db), existing), 'existing database');
  await expect(initializePluginSecretsKey(db)).rejects.toThrow('original plugin secrets key');
  expect(await Bun.file(pluginSecretsKeyPath(db)).exists()).toBe(false);
  const key = randomBytes(32).toString('base64');
  expect(await initializePluginSecretsKey(db, key)).toBe(key);
});

test('symlinked key files are rejected without modifying their targets', async () => {
  const db = database(), targetDb = database();
  const key = await initializePluginSecretsKey(targetDb);
  await mkdir(dirname(db), { recursive: true });
  await symlink(pluginSecretsKeyPath(targetDb), pluginSecretsKeyPath(db));
  await expect(readPluginSecretsKey(db)).rejects.toThrow('owner-only');
  await expect(initializePluginSecretsKey(db)).rejects.toThrow('owner-only');
  expect(await readPluginSecretsKey(targetDb)).toBe(key);
});

test('public key files are rejected without repairing their permissions', async () => {
  const db = database();
  await initializePluginSecretsKey(db);
  if (process.platform === 'win32') {
    const grant = Bun.spawn(['icacls.exe', pluginSecretsKeyPath(db), '/grant', '*S-1-1-0:(R)'], { stdout: 'pipe', stderr: 'pipe' });
    await Promise.all([new Response(grant.stdout).text(), new Response(grant.stderr).text()]);
    expect(await grant.exited).toBe(0);
  } else await chmod(pluginSecretsKeyPath(db), 0o644);
  await expect(readPluginSecretsKey(db)).rejects.toThrow();
  await expect(initializePluginSecretsKey(db)).rejects.toThrow();
  if (process.platform !== 'win32') expect((await lstat(pluginSecretsKeyPath(db))).mode & 0o777).toBe(0o644);
});
