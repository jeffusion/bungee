import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface BodyStorageConfig {
  enabled: boolean;
  maxSize: number;      // 最大大小（字节）
  retentionDays: number; // 保留天数
}

const DEFAULT_CONFIG: BodyStorageConfig = {
  enabled: true,
  maxSize: 5120,        // 5 KB
  retentionDays: 1,     // 1 天
};

/**
 * Body 存储管理器
 *
 * 特性：
 * - 按日期分层存储（logs/bodies/YYYY-MM-DD/）
 * - 大小限制检查
 * - 自动清理过期数据
 */
export class BodyStorageManager {
  private config: BodyStorageConfig;
  private readonly bodiesDir: string;

  constructor(
    config: Partial<BodyStorageConfig> = {},
    bodiesDir: string = path.resolve(process.cwd(), 'logs', 'bodies')
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.bodiesDir = bodiesDir;
    this.ensureBodiesDir();
  }

  /**
   * 保存 body 内容
   * @returns body ID（如果保存成功），或 null
   */
  async save(
    requestId: string,
    body: any,
    type: 'request' | 'response'
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // 序列化 body
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

      // 检查大小
      if (Buffer.byteLength(bodyStr) > this.config.maxSize) {
        logger.debug(
          { requestId, size: bodyStr.length, maxSize: this.config.maxSize },
          'Body exceeds max size, skipping storage'
        );
        return null;
      }

      // 生成 body ID
      const dateStr = this.getDateString();
      const bodyId = `${dateStr}/${type}-${requestId}`;
      const filePath = this.getBodyFilePath(bodyId);

      // 确保日期目录存在
      const dateDir = path.dirname(filePath);
      if (!fs.existsSync(dateDir)) {
        fs.mkdirSync(dateDir, { recursive: true });
      }

      // 写入文件
      await fs.promises.writeFile(filePath, bodyStr, 'utf-8');

      return bodyId;
    } catch (error) {
      logger.error({ error, requestId }, 'Failed to save body');
      return null;
    }
  }

  /**
   * 读取 body 内容
   */
  async load(bodyId: string): Promise<any | null> {
    try {
      const filePath = this.getBodyFilePath(bodyId);

      if (!fs.existsSync(filePath)) {
        return null;
      }

      const content = await fs.promises.readFile(filePath, 'utf-8');

      // 尝试解析为 JSON
      try {
        return JSON.parse(content);
      } catch {
        // 如果不是 JSON，返回原始字符串
        return content;
      }
    } catch (error) {
      logger.error({ error, bodyId }, 'Failed to load body');
      return null;
    }
  }

  /**
   * 清理过期 body 数据
   */
  async cleanup(): Promise<{ deletedDirs: number; deletedFiles: number }> {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - this.config.retentionDays);

    let deletedDirs = 0;
    let deletedFiles = 0;

    try {
      if (!fs.existsSync(this.bodiesDir)) {
        return { deletedDirs, deletedFiles };
      }

      const dirs = fs.readdirSync(this.bodiesDir);

      for (const dir of dirs) {
        // 只处理日期格式的目录
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dir)) {
          continue;
        }

        const dirDate = new Date(dir);
        if (dirDate < cutoffDate) {
          const dirPath = path.join(this.bodiesDir, dir);
          const files = fs.readdirSync(dirPath);
          deletedFiles += files.length;

          // 删除整个目录
          fs.rmSync(dirPath, { recursive: true });
          deletedDirs++;
        }
      }

      logger.info(
        { deletedDirs, deletedFiles, retentionDays: this.config.retentionDays },
        'Body cleanup completed'
      );

      return { deletedDirs, deletedFiles };
    } catch (error) {
      logger.error({ error }, 'Failed to cleanup bodies');
      return { deletedDirs, deletedFiles };
    }
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<BodyStorageConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * 获取配置
   */
  getConfig(): BodyStorageConfig {
    return { ...this.config };
  }

  /**
   * 获取 body 文件路径
   */
  private getBodyFilePath(bodyId: string): string {
    return path.join(this.bodiesDir, `${bodyId}.json`);
  }

  /**
   * 获取日期字符串（YYYY-MM-DD）
   */
  private getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0];
  }

  /**
   * 确保 bodies 目录存在
   */
  private ensureBodiesDir(): void {
    if (!fs.existsSync(this.bodiesDir)) {
      fs.mkdirSync(this.bodiesDir, { recursive: true });
    }
  }
}

// 单例实例
export const bodyStorageManager = new BodyStorageManager();
