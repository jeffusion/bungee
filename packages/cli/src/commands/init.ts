import { ConfigPaths } from '../config/paths';
import { resolve, join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolveCoreLaunchDescriptor, type LaunchDescriptor } from '../daemon/manager';
import { initializePluginSecretsKey, pluginSecretsKeyPath, withPluginSecretsKey } from '../config/plugin-secrets-key';

export async function initCommand(options: {pluginSecretsKey?: string; directLaunch?: LaunchDescriptor; launchDescriptor?: LaunchDescriptor} = {}): Promise<void> {
  const configDbPath = resolve(process.env.BUNGEE_CONFIG_DB_PATH ?? join(ConfigPaths.DATA_DIR, 'bungee.db'));
  const accessDbPath = resolve(process.env.BUNGEE_ACCESS_DB_PATH ?? join(ConfigPaths.LOGS_DIR, 'access.db'));
  const key = await initializePluginSecretsKey(configDbPath, options.pluginSecretsKey ?? process.env.BUNGEE_PLUGIN_SECRETS_KEY);
  await mkdir(dirname(accessDbPath), { recursive: true });
  const launch = await resolveCoreLaunchDescriptor(options);
  await new Promise<void>((accept, reject) => {
    const child = spawn(launch.executable, [...(launch.entrypoint === null ? [] : [launch.entrypoint]), '--initialize-config', configDbPath], {cwd:dirname(configDbPath),stdio:'inherit',env:{...withPluginSecretsKey(process.env,key),BUNGEE_ROLE:'master',BUNGEE_ACCESS_DB_PATH:accessDbPath}});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Configuration initialization failed (${code})`)));
  });
  console.log(`Bungee data directory initialized at: ${dirname(configDbPath)}`);
  console.log(`Configuration database: ${configDbPath}`);
  console.log(`Plugin state database: ${join(dirname(configDbPath), 'plugin-state.db')}`);
  console.log(`Plugin secrets key file: ${pluginSecretsKeyPath(configDbPath)}`);
  console.log(`Telemetry database: ${accessDbPath}`);
  console.log('Start Bungee with: bungee start');
}
