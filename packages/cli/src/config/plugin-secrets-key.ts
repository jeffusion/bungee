import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { assertWindowsOwnerOnlyFileAcl, secureWindowsOwnerOnlyFileAcl, type WindowsAclAdapter } from '@jeffusion/bungee-types/daemon-file';

type FileOptions = { platform?: NodeJS.Platform; windowsAcl?: WindowsAclAdapter };
const UNSAFE_FILE = 'Plugin secrets key must be an owner-only regular file containing a canonical Base64 key for 32 bytes';

export function pluginSecretsKeyPath(configDbPath: string): string {
  return join(dirname(configDbPath), 'plugin-secrets.key');
}

export function withPluginSecretsKey(environment: Readonly<Record<string, string | undefined>>, key: string): Record<string, string | undefined> {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([name]) => name.toLowerCase() !== 'bungee_plugin_secrets_key')),
    BUNGEE_PLUGIN_SECRETS_KEY: key,
  };
}

function validateKey(value: string): string {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) {
    throw new Error('Plugin secrets key must be canonical Base64 for 32 bytes');
  }
  return value;
}

async function readKeyFile(path: string, options: FileOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(UNSAFE_FILE);
  const file = await open(path, constants.O_RDONLY | (platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK));
  try {
    const opened = await file.stat();
    const verify = (item: typeof opened) => {
      if (!item.isFile() || item.nlink !== 1 || item.dev !== before.dev || item.ino !== before.ino || item.size !== 44
        || (platform !== 'win32' && ((item.mode & 0o777) !== 0o600 || (process.geteuid && item.uid !== process.geteuid())))) throw new Error(UNSAFE_FILE);
    };
    verify(opened);
    if (platform === 'win32') await assertWindowsOwnerOnlyFileAcl(path, options.windowsAcl);
    const value = await file.readFile('utf8');
    verify(await file.stat());
    const after = await lstat(path);
    verify(after);
    return validateKey(value);
  } finally { await file.close(); }
}

/** Runtime commands only read the initialized key; inherited environment cannot replace it. */
export async function readPluginSecretsKey(configDbPath: string, options: FileOptions = {}): Promise<string> {
  try { return await readKeyFile(pluginSecretsKeyPath(configDbPath), options); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Plugin secrets key is missing. Run bungee init first.');
    throw error;
  }
}

/** Initialization is the only writer. Existing keys are never replaced. */
export async function initializePluginSecretsKey(configDbPath: string, suppliedKey?: string, options: FileOptions = {}): Promise<string> {
  if (suppliedKey !== undefined) validateKey(suppliedKey);
  const path = pluginSecretsKeyPath(configDbPath);
  try {
    const existing = await readKeyFile(path, options);
    if (suppliedKey !== undefined && suppliedKey !== existing) throw new Error('Plugin secrets key is already initialized with a different key');
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (suppliedKey === undefined) {
    for (const database of [configDbPath, join(dirname(configDbPath), 'plugin-state.db')]) {
      try {
        await lstat(database);
        throw new Error('An existing database requires its original plugin secrets key when running bungee init');
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
  const key = suppliedKey ?? randomBytes(32).toString('base64');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'wx', 0o600);
  const created = await file.stat();
  try {
    if ((options.platform ?? process.platform) === 'win32') await secureWindowsOwnerOnlyFileAcl(path, options.windowsAcl);
    else await file.chmod(0o600);
    await file.writeFile(key);
    await file.sync();
  } catch (error) {
    const current = await lstat(path);
    if (current.dev === created.dev && current.ino === created.ino) await unlink(path);
    throw error;
  } finally { await file.close(); }
  return readKeyFile(path, options);
}
