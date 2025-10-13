import path from 'path';
import os from 'os';

export class ConfigPaths {
  public static readonly CONFIG_DIR = path.join(os.homedir(), '.bungee');
  public static readonly DEFAULT_CONFIG_FILE = path.join(ConfigPaths.CONFIG_DIR, 'config.json');
  public static readonly PID_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.pid');
  public static readonly LOG_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.log');
  public static readonly ERROR_LOG_FILE = path.join(ConfigPaths.CONFIG_DIR, 'bungee.error.log');
  public static readonly DATA_DIR = path.join(ConfigPaths.CONFIG_DIR, 'data');
  public static readonly STATS_DIR = path.join(ConfigPaths.DATA_DIR, 'stats');

  /**
   * 解析配置文件路径，如果没有提供则使用默认路径
   */
  public static resolveConfigPath(userProvidedPath?: string): string {
    if (userProvidedPath) {
      return path.resolve(userProvidedPath);
    }
    return ConfigPaths.DEFAULT_CONFIG_FILE;
  }

  /**
   * 确保配置目录存在
   */
  public static ensureConfigDir(): void {
    const fs = require('fs');
    if (!fs.existsSync(ConfigPaths.CONFIG_DIR)) {
      fs.mkdirSync(ConfigPaths.CONFIG_DIR, { recursive: true });
    }
  }
}