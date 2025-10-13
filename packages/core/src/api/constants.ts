import type { TimeRange, TimeRangeConfig } from './types';
import path from 'path';
import os from 'os';

export const TIME_RANGES: Record<TimeRange, TimeRangeConfig> = {
  '1h': {
    range: '1h',
    interval: 60 * 1000,      // 1分钟
    maxPoints: 60,             // 60个点
    displayName: '1小时'
  },
  '12h': {
    range: '12h',
    interval: 30 * 60 * 1000,  // 30分钟
    maxPoints: 24,             // 24个点
    displayName: '12小时'
  },
  '24h': {
    range: '24h',
    interval: 60 * 60 * 1000,  // 1小时
    maxPoints: 24,             // 24个点
    displayName: '24小时'
  }
};

/**
 * 获取数据目录路径
 * 优先级：环境变量 DATA_DIR > ~/.bungee/data/stats > ./data/stats
 */
function getDataDir(): string {
  if (process.env.DATA_DIR) {
    return process.env.DATA_DIR;
  }

  // CLI模式：使用 ~/.bungee/data/stats
  if (process.env.CONFIG_PATH?.includes('.bungee')) {
    return path.join(os.homedir(), '.bungee', 'data', 'stats');
  }

  // 开发模式：使用相对路径
  return './data/stats/';
}

export const STORAGE_CONFIG = {
  dataDir: getDataDir(),
  retentionHours: 24,
  fileFormat: 'json' as const,
  maxResponseTimeSamples: 100  // 限制响应时间样本数量防止内存泄漏
};