import { ConfigPaths } from '../config/paths';

export async function initCommand(): Promise<void> {
  ConfigPaths.ensureDataDir();
  ConfigPaths.ensureLogsDir();
  console.log(`Bungee data directory initialized at: ${ConfigPaths.DATA_DIR}`);
  console.log(`Configuration database: ${ConfigPaths.DATA_DIR}/bungee.db`);
  console.log(`Telemetry database: ${ConfigPaths.LOGS_DIR}/access.db`);
  console.log('Start Bungee with: bungee start');
}
