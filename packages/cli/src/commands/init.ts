import { ConfigPaths } from '../config/paths';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';
import { resolveCoreLaunchDescriptor, type LaunchDescriptor } from '../daemon/manager';

export async function initCommand(options: {directLaunch?: LaunchDescriptor; launchDescriptor?: LaunchDescriptor} = {}): Promise<void> {
  ConfigPaths.ensureDataDir();
  ConfigPaths.ensureLogsDir();
  const configDbPath = resolve(process.env.BUNGEE_CONFIG_DB_PATH ?? join(ConfigPaths.DATA_DIR, 'bungee.db'));
  const launch = await resolveCoreLaunchDescriptor(options);
  await new Promise<void>((accept, reject) => {
    const child = spawn(launch.executable, [...(launch.entrypoint === null ? [] : [launch.entrypoint]), '--initialize-config', configDbPath], {cwd:ConfigPaths.DATA_DIR,stdio:'inherit',env:{...process.env,BUNGEE_ROLE:'master'}});
    child.once('error', reject);
    child.once('exit', code => code === 0 ? accept() : reject(new Error(`Configuration initialization failed (${code})`)));
  });
  console.log(`Bungee data directory initialized at: ${ConfigPaths.DATA_DIR}`);
  console.log(`Configuration database: ${configDbPath}`);
  console.log(`Telemetry database: ${ConfigPaths.LOGS_DIR}/access.db`);
  console.log('Start Bungee with: bungee start');
}
