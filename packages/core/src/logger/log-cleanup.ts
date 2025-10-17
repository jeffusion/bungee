import { accessLogWriter } from './access-log-writer';
import { fileLogWriter } from './file-log-writer';
import { bodyStorageManager } from './body-storage';
import { logger } from '../logger';

export interface CleanupConfig {
  enabled: boolean;
  retentionDays: number;
  scheduleIntervalHours: number;
}

const DEFAULT_CONFIG: CleanupConfig = {
  enabled: true,
  retentionDays: 1, // Keep 24 hours (1 day) in SQLite for fast queries
  scheduleIntervalHours: 1, // Run every hour to keep SQLite size small
};

/**
 * 日志清理服务
 *
 * 特性：
 * - 定期自动清理过期日志
 * - 可配置保留天数
 * - 支持手动触发清理
 * - 执行 VACUUM 以回收磁盘空间
 */
export class LogCleanupService {
  private config: CleanupConfig;
  private cleanupTimer: Timer | null = null;
  private isRunning = false;

  constructor(config: Partial<CleanupConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 启动自动清理服务
   */
  start(): void {
    if (!this.config.enabled) {
      logger.info('Log cleanup service is disabled');
      return;
    }

    if (this.cleanupTimer) {
      logger.warn('Log cleanup service is already running');
      return;
    }

    logger.info(
      { config: this.config },
      'Starting log cleanup service'
    );

    // 立即执行一次清理
    this.runCleanup().catch(error => {
      logger.error({ error }, 'Initial log cleanup failed');
    });

    // 设置定期清理
    const intervalMs = this.config.scheduleIntervalHours * 60 * 60 * 1000;
    this.cleanupTimer = setInterval(() => {
      this.runCleanup().catch(error => {
        logger.error({ error }, 'Scheduled log cleanup failed');
      });
    }, intervalMs);

    logger.info(
      { intervalHours: this.config.scheduleIntervalHours },
      'Log cleanup service started'
    );
  }

  /**
   * 停止自动清理服务
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Log cleanup service stopped');
    }
  }

  /**
   * 执行清理任务
   */
  async runCleanup(): Promise<{
    deletedSqliteRecords: number;
    deletedFileLogFiles: number;
    deletedBodyDirs: number;
    deletedBodyFiles: number;
    durationMs: number;
  }> {
    if (this.isRunning) {
      logger.warn('Cleanup is already running, skipping this run');
      return {
        deletedSqliteRecords: 0,
        deletedFileLogFiles: 0,
        deletedBodyDirs: 0,
        deletedBodyFiles: 0,
        durationMs: 0
      };
    }

    this.isRunning = true;
    const startTime = Date.now();

    try {
      logger.info(
        { retentionDays: this.config.retentionDays },
        'Starting log cleanup'
      );

      // 清理 SQLite 数据库
      const deletedSqliteRecords = await accessLogWriter.cleanup(this.config.retentionDays);

      // 清理文件日志
      const deletedFileLogFiles = await fileLogWriter.cleanup(this.config.retentionDays);

      // 清理 Body 文件
      const { deletedDirs: deletedBodyDirs, deletedFiles: deletedBodyFiles } = await bodyStorageManager.cleanup();

      const durationMs = Date.now() - startTime;

      logger.info(
        {
          deletedSqliteRecords,
          deletedFileLogFiles,
          deletedBodyDirs,
          deletedBodyFiles,
          durationMs,
          retentionDays: this.config.retentionDays
        },
        'Log cleanup completed'
      );

      return {
        deletedSqliteRecords,
        deletedFileLogFiles,
        deletedBodyDirs,
        deletedBodyFiles,
        durationMs
      };
    } catch (error) {
      logger.error({ error }, 'Log cleanup failed');
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...config };
    logger.info({ config: this.config }, 'Log cleanup config updated');

    // 如果服务已启动，重新启动以应用新配置
    if (this.cleanupTimer) {
      this.stop();
      this.start();
    }
  }

  /**
   * 获取当前配置
   */
  getConfig(): CleanupConfig {
    return { ...this.config };
  }

  /**
   * 检查服务状态
   */
  isActive(): boolean {
    return this.cleanupTimer !== null;
  }
}

// 单例实例
export const logCleanupService = new LogCleanupService();

// 优雅关闭
process.on('SIGINT', () => {
  logCleanupService.stop();
});

process.on('SIGTERM', () => {
  logCleanupService.stop();
});
