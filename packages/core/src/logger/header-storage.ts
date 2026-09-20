import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export interface HeaderStorageConfig {
  enabled: boolean;
  retentionDays: number; // 保留天数
}

const HEADER_TYPES = ['original-request', 'request', 'response'] as const;
type HeaderType = typeof HEADER_TYPES[number];

const DEFAULT_CONFIG: HeaderStorageConfig = {
  enabled: true,
  retentionDays: 1, // 1 天
};

const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
]);

/**
 * Header 存储管理器
 *
 * 特性：
 * - 按日期分层存储（logs/headers/YYYY-MM-DD/）
 * - 默认启用
 * - 提供按日期清理能力（由 Master 调度）
 */
export class HeaderStorageManager {
  private config: HeaderStorageConfig;
  private readonly headersDir: string;

  constructor(
    config: Partial<HeaderStorageConfig> = {},
    headersDir: string = process.env.BUNGEE_HEADER_LOG_DIR ?? path.resolve(process.cwd(), 'logs', 'headers')
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.headersDir = headersDir;
  }

  /**
   * 保存 header 内容
   * @returns header ID（如果保存成功），或 null
   */
  async save(
    requestId: string,
    headers: Record<string, string>,
    type: 'request' | 'response' | 'original-request'
  ): Promise<string | null> {
    if (!this.config.enabled) {
      return null;
    }

    try {
      // 序列化 headers
      const persistedHeaders = Object.fromEntries(
        Object.entries(headers).filter(([name]) => !SENSITIVE_HEADERS.has(name.toLowerCase()))
      );
      const headersStr = JSON.stringify(persistedHeaders, null, 2);

      // 生成 header ID
      const dateStr = this.getDateString();
      const headerId = `${dateStr}/${type}-${requestId}`;
      const filePath = this.getHeaderFilePath(headerId);
      if (filePath === null) return null;

      // 确保日期目录存在
      const dateDir = path.dirname(filePath);
      if (!this.ensureSafeDirectory(dateDir) || !this.isSafeRegularFile(filePath)) return null;

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
      if (filePath === null || !(await this.isSafePath(filePath))) return null;

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
    cutoffDate.setUTCHours(0, 0, 0, 0);
    cutoffDate.setUTCDate(cutoffDate.getUTCDate() - this.config.retentionDays);

    let deletedDirs = 0;
    let deletedFiles = 0;

    try {
      let root: string;
      try {
        const stat = fs.lstatSync(this.headersDir);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          logger.warn({ directory: this.headersDir }, 'Skipping header cleanup: root is not a real directory');
          return { deletedDirs, deletedFiles };
        }
        root = fs.realpathSync(this.headersDir);
      } catch (error: any) {
        if (error?.code === 'ENOENT') return { deletedDirs, deletedFiles };
        logger.warn({ error, directory: this.headersDir }, 'Skipping header cleanup: root cannot be verified');
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
          try {
            const stat = fs.lstatSync(dirPath);
            if (!stat.isDirectory() || stat.isSymbolicLink()) {
              logger.warn({ directory: dirPath }, 'Skipping header cleanup entry: not a real directory');
              continue;
            }
            const canonical = fs.realpathSync(dirPath);
            const relative = path.relative(root, canonical);
            if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
              logger.warn({ directory: dirPath, canonical }, 'Skipping header cleanup entry outside root');
              continue;
            }
            deletedFiles += fs.readdirSync(dirPath).length;
            // Threat model: lstat/realpath blocks observed symlinks and escapes. The OS can
            // still race this check before rmSync; failures are caught and the entry is skipped.
            fs.rmSync(dirPath, { recursive: true });
            deletedDirs++;
          } catch (error) {
            logger.warn({ error, directory: dirPath }, 'Skipping header cleanup entry after verification failure');
          }
        }
      }

      logger.info(
        { deletedDirs, deletedFiles, retentionDays: this.config.retentionDays },
        'Header cleanup completed'
      );

      return { deletedDirs, deletedFiles };
    } catch (error) {
      logger.warn({ error }, 'Header cleanup skipped after verification failure');
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
  private getHeaderFilePath(headerId: string): string | null {
    if (/[\\\0]/.test(headerId) || /%(?:2f|2e|5c|00)/i.test(headerId)) return null;
    let decoded: string;
    try { decoded = decodeURIComponent(headerId); }
    catch { return null; }
    if (decoded.includes('%') || /[\\\0]/.test(decoded) || decoded.split('/').some(segment => segment === '.' || segment === '..')) return null;
    const parts = decoded.split('/');
    if (parts.length !== 2 || !this.isDate(parts[0])) return null;
    const typeAndId = parts[1];
    const type = HEADER_TYPES.find(candidate => typeAndId.startsWith(`${candidate}-`)) as HeaderType | undefined;
    if (type === undefined) return null;
    const requestId = typeAndId.slice(type.length + 1);
    if (requestId.length === 0 || requestId === '.' || requestId === '..' || requestId.includes('/')) return null;
    const base = path.resolve(this.headersDir);
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
    const base = path.resolve(this.headersDir);
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
    const base = path.resolve(this.headersDir);
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
   * 确保 headers 目录存在
   */
  private ensureHeadersDir(): void {
    if (!fs.existsSync(this.headersDir)) {
      fs.mkdirSync(this.headersDir, { recursive: true });
    }
  }
}
