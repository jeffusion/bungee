import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface HeaderStorageConfig {
  enabled: boolean;
  retentionDays: number; // 保留天数
}

const DEFAULT_CONFIG: HeaderStorageConfig = {
  enabled: true,
  retentionDays: 1, // 1 天
};

/**
 * Header 存储管理器
 *
 * 特性：
 * - 按日期分层存储（logs/headers/YYYY-MM-DD/）
 * - 默认启用
 * - 自动清理过期数据
 */
export class HeaderStorageManager {
  private config: HeaderStorageConfig;
  private readonly headersDir: string;

  constructor(
    config: Partial<HeaderStorageConfig> = {},
    headersDir: string = path.resolve(process.cwd(), 'logs', 'headers')
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.headersDir = headersDir;
    this.ensureHeadersDir();
  }

  /**
   * 保存 header 内容
   * @returns header ID（如果保存成功），或 null
   */
  async save(
    requestId: string,
    headers: Record<string, string>,
    type: 'request' | 'response'
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // 序列化 headers
      const headersStr = JSON.stringify(headers, null, 2);

      // 生成 header ID
      const dateStr = this.getDateString();
      const headerId = `${dateStr}/${type}-${requestId}`;
      const filePath = this.getHeaderFilePath(headerId);

      // 确保日期目录存在
      const dateDir = path.dirname(filePath);
      if (!fs.existsSync(dateDir)) {
        fs.mkdirSync(dateDir, { recursive: true });
      }

      // 写入文件
      await fs.promises.writeFile(filePath, headersStr, 'utf-8');

      return headerId;
    } catch (error) {
      logger.error({ error, requestId }, 'Failed to save headers');
      return null;
    }
  }

  /**
   * 读取 header 内容
   */
  async load(headerId: string): Promise<Record<string, string> | null> {
    try {
      const filePath = this.getHeaderFilePath(headerId);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.error({ error, headerId }, 'Failed to load headers');
      return null;
    }
  }

  /**
   * 清理过期 header 数据
   */
  async cleanup(): Promise<{ deletedDirs: number; deletedFiles: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

    let deletedDirs = 0;
    let deletedFiles = 0;

    try {
      if (!fs.existsSync(this.headersDir)) {
        return { deletedDirs, deletedFiles };
      }

      const dirs = fs.readdirSync(this.headersDir);

      for (const dir of dirs) {
        // 只处理日期格式的目录
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dir)) {
          continue;
        }

        const dirDate = new Date(dir);
        if (dirDate < cutoffDate) {
          const dirPath = path.join(this.headersDir, dir);
          const files = fs.readdirSync(dirPath);
          deletedFiles += files.length;

          // 删除整个目录
          fs.rmSync(dirPath, { recursive: true });
          deletedDirs++;
        }
      }

      logger.info(
        { deletedDirs, deletedFiles, retentionDays: this.config.retentionDays },
        'Header cleanup completed'
      );

      return { deletedDirs, deletedFiles };
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup headers');
      return { deletedDirs, deletedFiles };
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<HeaderStorageConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): HeaderStorageConfig {
    return { ...this.config };
  }

  /**
   * 获取 header 文件路径
   */
  private getHeaderFilePath(headerId: string): string {
    return path.join(this.headersDir, `${headerId}.json`);
  }

  /**
   * 获取日期字符串（YYYY-MM-DD）
   */
  private getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * 确保 headers 目录存在
   */
  private ensureHeadersDir(): void {
    if (!fs.existsSync(this.headersDir)) {
      fs.mkdirSync(this.headersDir, { recursive: true });
    }
  }
}

// 单例实例
export const headerStorageManager = new HeaderStorageManager();
