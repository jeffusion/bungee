import type { Database } from 'bun:sqlite';
import type { BodyStorageManager } from './body-storage';
import type { HeaderStorageManager } from './header-storage';
import { logger } from '../logger';

export interface CleanupConfig {
  enabled: boolean;
  retentionDays: number;
  scheduleIntervalHours: number;
}

export interface LogCleanupServiceOptions extends Partial<CleanupConfig> {
  readonly database: Database;
  readonly bodyStorage: Pick<BodyStorageManager, 'cleanup'>;
  readonly headerStorage: Pick<HeaderStorageManager, 'cleanup'>;
  readonly config?: Partial<CleanupConfig>;
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
 * - 仅删除过期 SQLite/body/header 数据；live 数据库不执行 VACUUM
 */
export class LogCleanupService {
  private config: CleanupConfig;
  private cleanupTimer: Timer | null = null;
  private initialCleanupTimer: ReturnType<typeof setTimeout> | null = null;
  private isRunning = false;
  private activeRun: Promise<unknown> | null = null;
  private readonly database: Database | null;
  private readonly bodyStorage: Pick<BodyStorageManager, 'cleanup'> | null;
  private readonly headerStorage: Pick<HeaderStorageManager, 'cleanup'> | null;

  constructor(options: LogCleanupServiceOptions);
  constructor(
    database: Database,
    bodyStorage: Pick<BodyStorageManager, 'cleanup'>,
    headerStorage: Pick<HeaderStorageManager, 'cleanup'>,
    config?: Partial<CleanupConfig>,
  );
  constructor(config?: Partial<CleanupConfig>);
  constructor(
    optionsOrDatabase: LogCleanupServiceOptions | Partial<CleanupConfig> | Database = {},
    bodyStorage?: Pick<BodyStorageManager, 'cleanup'>,
    headerStorage?: Pick<HeaderStorageManager, 'cleanup'>,
    config: Partial<CleanupConfig> = {},
  ) {
    if (bodyStorage !== undefined && headerStorage !== undefined && 'prepare' in optionsOrDatabase) {
      this.config = { ...DEFAULT_CONFIG, ...config };
      this.database = optionsOrDatabase as Database;
      this.bodyStorage = bodyStorage;
      this.headerStorage = headerStorage;
    } else if ('database' in optionsOrDatabase && 'bodyStorage' in optionsOrDatabase && 'headerStorage' in optionsOrDatabase) {
      this.config = {
        ...DEFAULT_CONFIG,
        enabled: optionsOrDatabase.enabled ?? DEFAULT_CONFIG.enabled,
        retentionDays: optionsOrDatabase.retentionDays ?? DEFAULT_CONFIG.retentionDays,
        scheduleIntervalHours: optionsOrDatabase.scheduleIntervalHours ?? DEFAULT_CONFIG.scheduleIntervalHours,
        ...(optionsOrDatabase.config ?? {}),
      };
      this.database = optionsOrDatabase.database;
      this.bodyStorage = optionsOrDatabase.bodyStorage;
      this.headerStorage = optionsOrDatabase.headerStorage;
    } else {
      this.config = { ...DEFAULT_CONFIG, ...(optionsOrDatabase as Partial<CleanupConfig>) };
      this.database = null;
      this.bodyStorage = null;
      this.headerStorage = null;
    }
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

    // Defer the first pass so startup observers can finish their first request.
    this.initialCleanupTimer = setTimeout(() => {
      this.initialCleanupTimer = null;
      this.runCleanup().catch(error => {
        logger.error({ error }, 'Initial log cleanup failed');
      });
    }, 0);

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
  async stop(): Promise<void> {
    if (this.initialCleanupTimer !== null) {
      clearTimeout(this.initialCleanupTimer);
      this.initialCleanupTimer = null;
    }
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
      logger.info('Log cleanup service stopped');
    }
    await this.activeRun;
  }

  /** Update the authoritative retention before the next scheduled/manual pass. */
  configure(config: Partial<CleanupConfig>): void {
    this.config = { ...this.config, ...config };
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

    if (this.database === null || this.bodyStorage === null || this.headerStorage === null) {
      throw new Error('log cleanup dependencies are unavailable');
    }

    this.isRunning = true;
    const startTime = Date.now();
    const config = { ...this.config };
    const database = this.database;
    const bodyStorage = this.bodyStorage;
    const headerStorage = this.headerStorage;
    const run = (async () => {
      try {
      logger.info(
        { retentionDays: config.retentionDays },
        'Starting log cleanup'
      );

      // Keep live cleanup strictly to deletion; VACUUM would contend with workers.
      const cutoffTime = Math.floor(Date.now() / 1000) - (config.retentionDays * 24 * 60 * 60);
      const deletedSqliteRecords = database.prepare(
        'DELETE FROM access_logs WHERE created_at < ?',
      ).run(cutoffTime).changes;

      // 清理 Body 文件
      const { deletedDirs: deletedBodyDirs, deletedFiles: deletedBodyFiles } = await bodyStorage.cleanup();
      await headerStorage.cleanup();
      const deletedFileLogFiles = 0;

      const durationMs = Date.now() - startTime;

      logger.info(
        {
          deletedSqliteRecords,
          deletedFileLogFiles,
          deletedBodyDirs,
          deletedBodyFiles,
          durationMs,
          retentionDays: config.retentionDays
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
    })();
    this.activeRun = run;
    try {
      return await run;
    } finally {
      if (this.activeRun === run) this.activeRun = null;
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
