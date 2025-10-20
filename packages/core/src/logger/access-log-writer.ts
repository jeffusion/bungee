import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';

export interface ProcessingStep {
  step: string;
  detail?: any;
  timestamp: number;
}

export interface AccessLogEntry {
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
  processingSteps?: ProcessingStep[];
  authSuccess?: boolean;
  authLevel?: string;
  errorMessage?: string;
  reqBodyId?: string;
  respBodyId?: string;
  reqHeaderId?: string;
  respHeaderId?: string;
}

/**
 * 异步日志写入器
 *
 * 特性：
 * - 异步队列，不阻塞请求响应
 * - 批量提交（事务）
 * - 定期刷新（5秒）
 * - 队列超过 100 条立即刷新
 */
export class AccessLogWriter {
  private db: Database;
  private writeQueue: AccessLogEntry[] = [];
  private isProcessing = false;
  private flushInterval: Timer | null = null;

  constructor(dbPath: string) {
    // 确保目录存在
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.initDatabase();
    this.startFlushInterval();
  }

  /**
   * 初始化数据库表结构
   */
  private initDatabase() {
    // 创建 access_logs 表
    this.db.run(`
      CREATE TABLE IF NOT EXISTS access_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT UNIQUE NOT NULL,
        timestamp INTEGER NOT NULL,

        -- 请求基本信息
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        query TEXT,
        status INTEGER NOT NULL,
        duration INTEGER NOT NULL,

        -- 业务信息
        route_path TEXT,
        upstream TEXT,
        transformer TEXT,

        -- 处理步骤（JSON）
        processing_steps TEXT,

        -- 认证信息
        auth_success INTEGER DEFAULT 1,
        auth_level TEXT,

        -- 错误信息
        error_message TEXT,

        -- Body 引用 ID
        req_body_id TEXT,
        resp_body_id TEXT,

        -- Header 引用 ID
        req_header_id TEXT,
        resp_header_id TEXT,

        -- 索引字段
        success INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      )
    `);

    // 添加 body 列（兼容旧数据库）
    try {
      this.db.run('ALTER TABLE access_logs ADD COLUMN req_body_id TEXT');
    } catch {
      // Column already exists
    }
    try {
      this.db.run('ALTER TABLE access_logs ADD COLUMN resp_body_id TEXT');
    } catch {
      // Column already exists
    }

    // 添加 header 列（兼容旧数据库）
    try {
      this.db.run('ALTER TABLE access_logs ADD COLUMN req_header_id TEXT');
    } catch {
      // Column already exists
    }
    try {
      this.db.run('ALTER TABLE access_logs ADD COLUMN resp_header_id TEXT');
    } catch {
      // Column already exists
    }

    // 创建索引
    this.db.run('CREATE INDEX IF NOT EXISTS idx_timestamp ON access_logs(timestamp DESC)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_path ON access_logs(path)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_status ON access_logs(status)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_success ON access_logs(success)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_created_at ON access_logs(created_at)');
    this.db.run('CREATE INDEX IF NOT EXISTS idx_request_id ON access_logs(request_id)');

    // 创建统计快照表（用于快速统计）
    this.db.run(`
      CREATE TABLE IF NOT EXISTS stats_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        total_requests INTEGER,
        success_requests INTEGER,
        failed_requests INTEGER,
        avg_response_time REAL,
        created_at INTEGER NOT NULL
      )
    `);
  }

  /**
   * 异步写入日志（入队）
   */
  async write(entry: AccessLogEntry): Promise<void> {
    this.writeQueue.push(entry);

    // 队列超过 100 条立即刷新
    if (this.writeQueue.length >= 100) {
      await this.flush();
    }
  }

  /**
   * 批量刷新到数据库
   */
  async flush(): Promise<void> {
    if (this.isProcessing || this.writeQueue.length === 0) {
      return;
    }

    this.isProcessing = true;
    const batch = this.writeQueue.splice(0);

    try {
      const insert = this.db.prepare(`
        INSERT INTO access_logs (
          request_id, timestamp, method, path, query,
          status, duration, route_path, upstream, transformer,
          processing_steps, auth_success, auth_level,
          error_message, req_body_id, resp_body_id, req_header_id, resp_header_id, success, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.db.run('BEGIN TRANSACTION');

      for (const entry of batch) {
        insert.run(
          entry.requestId,
          entry.timestamp,
          entry.method,
          entry.path,
          entry.query || null,
          entry.status,
          entry.duration,
          entry.routePath || null,
          entry.upstream || null,
          entry.transformer || null,
          entry.processingSteps ? JSON.stringify(entry.processingSteps) : null,
          entry.authSuccess !== undefined ? (entry.authSuccess ? 1 : 0) : 1,
          entry.authLevel || null,
          entry.errorMessage || null,
          entry.reqBodyId || null,
          entry.respBodyId || null,
          entry.reqHeaderId || null,
          entry.respHeaderId || null,
          entry.status < 400 ? 1 : 0,
          Math.floor(entry.timestamp / 1000)
        );
      }

      this.db.run('COMMIT');
    } catch (error) {
      this.db.run('ROLLBACK');
      console.error('Failed to flush access logs:', error);
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
   * 优雅关闭
   */
  async close(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    await this.flush();
    this.db.close();
  }

  /**
   * 清理过期日志（保留 30 天）
   */
  async cleanup(retentionDays: number = 30): Promise<number> {
    const cutoffTime = Math.floor(Date.now() / 1000) - (retentionDays * 24 * 60 * 60);

    const result = this.db.run('DELETE FROM access_logs WHERE created_at < ?', [cutoffTime]);
    this.db.run('VACUUM');

    return result.changes;
  }

  /**
   * 获取数据库实例（只读）
   */
  getDatabase(): Database {
    return this.db;
  }
}

// 单例实例
const dbPath = path.resolve(process.cwd(), 'logs', 'access.db');
export const accessLogWriter = new AccessLogWriter(dbPath);

// 优雅关闭处理
process.on('SIGINT', async () => {
  await accessLogWriter.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  await accessLogWriter.close();
  process.exit(0);
});
