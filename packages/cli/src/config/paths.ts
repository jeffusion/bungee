import path from 'path';
import os from 'os';
import fs from 'fs';

export class ConfigPaths {
  public static readonly CONFIG_DIR = path.join(os.homedir(), '.bungee');
  public static readonly PID_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.pid');
  public static readonly LOG_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.log');
  public static readonly ERROR_LOG_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.error.log');
  public static readonly DATA_DIR = path.join(ConfigPaths.CONFIG_DIR, 'data');
  public static readonly LOGS_DIR = path.join(ConfigPaths.CONFIG_DIR, 'logs');
  public static readonly STATS_DIR = path.join(ConfigPaths.DATA_DIR, 'stats');

  /**
   * 确保配置目录存在
   */
  public static ensureConfigDir(): void {
    fs.mkdirSync(ConfigPaths.CONFIG_DIR, { recursive: true });
  }

  public static ensureDataDir(): void {
    fs.mkdirSync(ConfigPaths.DATA_DIR, { recursive: true });
  }

  public static ensureLogsDir(): void {
    fs.mkdirSync(ConfigPaths.LOGS_DIR, { recursive: true });
  }
}
