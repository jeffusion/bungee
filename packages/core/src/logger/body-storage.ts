import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface BodyStorageConfig {
  enabled: boolean;
  maxSize: number;      // 最大大小（字节）
  retentionDays: number; // 保留天数
}

const BODY_TYPES = ['original-request', 'request', 'response'] as const;
type BodyType = typeof BODY_TYPES[number];

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
 * - 提供按日期清理能力（由 Master 调度）
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
  }

  /**
   * 保存 body 内容
   * @param requestId 请求 ID
   * @param body body 内容
   * @param type body 类型（request/response）
   * @param isErrorResponse 是否是错误响应（错误响应不受大小限制）
   * @returns body ID（如果保存成功），或 null
   */
  async save(
    requestId: string,
    body: any,
    type: 'request' | 'response' | 'original-request',
    isErrorResponse: boolean = false
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // 序列化 body
      const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

      // 检查大小（错误响应不受大小限制）
      if (!isErrorResponse && Buffer.byteLength(bodyStr) > this.config.maxSize) {
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
      if (filePath === null) return null;

      // 确保日期目录存在
      const dateDir = path.dirname(filePath);
      if (!this.ensureSafeDirectory(dateDir) || !this.isSafeRegularFile(filePath)) return null;

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
      if (filePath === null || !(await this.isSafePath(filePath))) return null;

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
    cutoffDate.setUTCHours(0, 0, 0, 0);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.config.retentionDays);

    let deletedDirs = 0;
    let deletedFiles = 0;

    try {
      let root: string;
      try {
        const stat = fs.lstatSync(this.bodiesDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          logger.warn({ directory: this.bodiesDir }, 'Skipping body cleanup: root is not a real directory');
          return { deletedDirs, deletedFiles };
        }
        root = fs.realpathSync(this.bodiesDir);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return { deletedDirs, deletedFiles };
        logger.warn({ error, directory: this.bodiesDir }, 'Skipping body cleanup: root cannot be verified');
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
          try {
            const stat = fs.lstatSync(dirPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
              logger.warn({ directory: dirPath }, 'Skipping body cleanup entry: not a real directory');
              continue;
            }
            const canonical = fs.realpathSync(dirPath);
            const relative = path.relative(root, canonical);
            if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
              logger.warn({ directory: dirPath, canonical }, 'Skipping body cleanup entry outside root');
              continue;
            }
            deletedFiles += fs.readdirSync(dirPath).length;
            // Threat model: lstat/realpath blocks observed symlinks and escapes. The OS can
            // still race this check before rmSync; failures are caught and the entry is skipped.
            fs.rmSync(dirPath, { recursive: true });
            deletedDirs++;
          } catch (error) {
            logger.warn({ error, directory: dirPath }, 'Skipping body cleanup entry after verification failure');
          }
        }
      }

      logger.info(
        { deletedDirs, deletedFiles, retentionDays: this.config.retentionDays },
        'Body cleanup completed'
      );

      return { deletedDirs, deletedFiles };
    } catch (error) {
      logger.warn({ error }, 'Body cleanup skipped after verification failure');
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
  private getBodyFilePath(bodyId: string): string | null {
    if (/[\\\0]/.test(bodyId) || /%(?:2f|2e|5c|00)/i.test(bodyId)) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(bodyId); }
    catch { return null; }
    if (decoded.includes('%') || /[\\\0]/.test(decoded) || decoded.includes('/../') || decoded.startsWith('../')
      || decoded.endsWith('/..') || decoded.split('/').some(segment => segment === '.' || segment === '..')) return null;
    const parts = decoded.split('/');
    if (parts.length !== 2 || !this.isDate(parts[0])) return null;
    const typeAndId = parts[1];
    const type = BODY_TYPES.find(candidate => typeAndId.startsWith(`${candidate}-`)) as BodyType | undefined;
    if (type === undefined) return null;
    const requestId = typeAndId.slice(type.length + 1);
    if (requestId.length === 0 || requestId === '.' || requestId === '..' || requestId.includes('/')) return null;
    const base = path.resolve(this.bodiesDir);
    const dateDir = path.resolve(base, parts[0]);
    const filePath = path.resolve(dateDir, `${type}-${requestId}.json`);
    if (dateDir !== base && !dateDir.startsWith(`${base}${path.sep}`)) return null;
    if (!filePath.startsWith(`${dateDir}${path.sep}`) || !filePath.startsWith(`${base}${path.sep}`)) return null;
    return filePath;
  }

  private isDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return date.getUTCFullYear() === Number(value.slice(0, 4))
      && date.getUTCMonth() + 1 === Number(value.slice(5, 7))
      && date.getUTCDate() === Number(value.slice(8, 10));
  }

  private isSafeDirectory(directory: string): boolean {
    const base = path.resolve(this.bodiesDir);
    const target = path.resolve(directory);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return false;
    let current = path.parse(base).root;
    for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      } catch { return false; }
    }
    return true;
  }

  private ensureSafeDirectory(directory: string): boolean {
    const base = path.resolve(this.bodiesDir);
    const target = path.resolve(directory);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) return false;
    let current = path.parse(base).root;
    for (const segment of path.relative(current, target).split(path.sep).filter(Boolean)) {
      current = path.join(current, segment);
      try {
        const stat = fs.lstatSync(current);
        if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
      } catch (error: any) {
        if (error?.code !== 'ENOENT') return false;
        try { fs.mkdirSync(current); }
        catch { return false; }
        try {
          const stat = fs.lstatSync(current);
          if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
        } catch { return false; }
      }
    }
    return true;
  }

  private isSafeRegularFile(filePath: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error: any) {
      return error?.code === 'ENOENT';
    }
  }

  private async isSafePath(filePath: string): Promise<boolean> {
    const dateDir = path.dirname(filePath);
    if (!this.isSafeDirectory(dateDir)) return false;
    try {
      const stat = await fs.promises.lstat(filePath);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch (error: any) {
      return error?.code === 'ENOENT';
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
   * 确保 bodies 目录存在
   */
  private ensureBodiesDir(): void {
    if (!fs.existsSync(this.bodiesDir)) {
      fs.mkdirSync(this.bodiesDir, { recursive: true });
    }
  }
}
