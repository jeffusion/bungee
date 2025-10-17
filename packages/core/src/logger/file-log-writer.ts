import fs from 'fs';
import path from 'path';

export interface FileLogEntry {
  requestId: string;
  timestamp: number;
  method: string;
  path: string;
  query?: string;
  status: number;
  duration: number;
  routePath?: string;
  upstream?: string;
  transformer?: string;
  authSuccess?: boolean;
  authLevel?: string;
  errorMessage?: string;
  // Body 引用 ID
  reqBodyId?: string;
  respBodyId?: string;
}

/**
 * 文件日志写入器（JSON Lines 格式）
 *
 * 特性：
 * - 异步批量写入
 * - JSON Lines 格式（每行一个 JSON）
 * - 自动按天 rotate
 * - 不阻塞请求处理
 */
export class FileLogWriter {
  private writeQueue: FileLogEntry[] = [];
  private isProcessing = false;
  private flushInterval: Timer | null = null;
  private currentDate: string;
  private currentStream: fs.WriteStream | null = null;
  private readonly logsDir: string;

  constructor(logsDir: string = path.resolve(process.cwd(), 'logs')) {
    this.logsDir = logsDir;
    this.currentDate = this.getDateString();
    this.ensureLogsDir();
    this.openLogFile();
    this.startFlushInterval();
  }

  /**
   * 异步写入日志（入队）
   */
  async write(entry: FileLogEntry): Promise<void> {
    this.writeQueue.push(entry);

    // 队列超过 100 条立即刷新
    if (this.writeQueue.length >= 100) {
      await this.flush();
    }
  }

  /**
   * 批量刷新到文件
   */
  async flush(): Promise<void> {
    if (this.isProcessing || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const batch = this.writeQueue.splice(0);

    try {
      // 检查是否需要 rotate
      const currentDate = this.getDateString();
      if (currentDate !== this.currentDate) {
        await this.rotateLogFile();
      }

      // 批量写入
      const lines = batch.map(entry => JSON.stringify(entry)).join('\n') + '\n';

      if (this.currentStream) {
        await new Promise<void>((resolve, reject) => {
          this.currentStream!.write(lines, (err) => {
            if (err) reject(err);
            else resolve();
          });
        });
      }
    } catch (error) {
      console.error('Failed to write file logs:', error);
      // 失败的日志重新入队
      this.writeQueue.unshift(...batch);
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * 定期刷新（每 5 秒）
   */
  private startFlushInterval() {
    this.flushInterval = setInterval(() => {
      this.flush();
    }, 5000);
  }

  /**
   * 日志文件 rotate
   */
  private async rotateLogFile(): Promise<void> {
    // 关闭当前文件流
    if (this.currentStream) {
      await new Promise<void>((resolve) => {
        this.currentStream!.end(() => resolve());
      });
      this.currentStream = null;
    }

    // 更新日期并打开新文件
    this.currentDate = this.getDateString();
    this.openLogFile();
  }

  /**
   * 打开日志文件
   */
  private openLogFile(): void {
    const logFilePath = path.join(this.logsDir, `access-${this.currentDate}.log`);
    this.currentStream = fs.createWriteStream(logFilePath, { flags: 'a' });
  }

  /**
   * 确保日志目录存在
   */
  private ensureLogsDir(): void {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }
  }

  /**
   * 获取日期字符串（YYYY-MM-DD）
   */
  private getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * 优雅关闭
   */
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    await this.flush();

    if (this.currentStream) {
      await new Promise<void>((resolve) => {
        this.currentStream!.end(() => resolve());
      });
      this.currentStream = null;
    }
  }

  /**
   * 清理过期日志（保留指定天数）
   */
  async cleanup(retentionDays: number = 30): Promise<number> {
    const files = fs.readdirSync(this.logsDir);
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - retentionDays);

    let deletedCount = 0;

    for (const file of files) {
      if (!file.startsWith('access-') || !file.endsWith('.log')) {
        continue;
      }

      // 从文件名提取日期
      const dateMatch = file.match(/access-(\d{4}-\d{2}-\d{2})\.log/);
      if (!dateMatch) continue;

      const fileDate = new Date(dateMatch[1]);
      if (fileDate < cutoffDate) {
        const filePath = path.join(this.logsDir, file);
        fs.unlinkSync(filePath);
        deletedCount++;
      }
    }

    return deletedCount;
  }
}

// 单例实例
export const fileLogWriter = new FileLogWriter();

// 优雅关闭处理
process.on('SIGINT', async () => {
  await fileLogWriter.close();
});

process.on('SIGTERM', async () => {
  await fileLogWriter.close();
});
