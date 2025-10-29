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
  transformedPath?: string;       // 转换后的路径（经过 pathRewrite）
  processingSteps?: ProcessingStep[];
  authSuccess?: boolean;
  authLevel?: string;
  errorMessage?: string;
  reqBodyId?: string;
  respBodyId?: string;
  reqHeaderId?: string;
  respHeaderId?: string;
  originalReqHeaderId?: string;  // 原始请求头 ID（转换前）
  originalReqBodyId?: string;     // 原始请求体 ID（转换前）
  // 故障转移相关字段
  isFailoverAttempt?: boolean;    // 是否是故障转移尝试（false=最终响应, true=重试尝试）
  parentRequestId?: string;       // 关联到主请求 ID（仅用于重试尝试）
  attemptNumber?: number;         // 尝试序号（1, 2, 3...）
  attemptUpstream?: string;       // 此次尝试的上游地址
  // 请求类型分类（互斥）
  requestType?: 'final' | 'retry' | 'recovery';  // final=返回客户端, retry=重试尝试, recovery=故障恢复测试
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

    // 打开数据库连接
    // NOTE: All schema initialization is handled by the migration system in master.ts
    // The database schema is guaranteed to be ready before workers start
    this.db = new Database(dbPath);
    this.startFlushInterval();
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
          error_message, req_body_id, resp_body_id, req_header_id, resp_header_id,
          original_req_header_id, original_req_body_id, transformed_path, success, created_at,
          is_failover_attempt, parent_request_id, attempt_number, attempt_upstream, request_type
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          entry.originalReqHeaderId || null,
          entry.originalReqBodyId || null,
          entry.transformedPath || null,
          entry.status < 400 ? 1 : 0,
          Math.floor(entry.timestamp / 1000),
          entry.isFailoverAttempt ? 1 : 0,
          entry.parentRequestId || null,
          entry.attemptNumber || null,
          entry.attemptUpstream || null,
          entry.requestType || 'final'
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
