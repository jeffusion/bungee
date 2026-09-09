import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';

export interface ProcessingStep {
  step: string;
  detail?: any;
  timestamp: number;
  /** 步骤耗时（毫秒），如果提供则优先使用 */
  duration?: number;
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
  protocolOutcome?: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  protocolCode?: string;
  /** Final outcome, not derived from HTTP status (200 may still be a protocol failure). */
  success?: boolean;
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
  private pendingRespBodyIdUpdates: Map<string, string> = new Map();
  private pendingProtocolOutcomeUpdates: Map<string, { outcome: NonNullable<AccessLogEntry['protocolOutcome']>; success: boolean; code?: string }> = new Map();
  private static readonly MAX_PENDING_UPDATES = 4096;
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
    this.db.run('PRAGMA busy_timeout = 5000');

    // WAL 由持有 access DB instance lock 的 master 在 worker 启动前设置。
    // NORMAL 同步模式在保证数据安全的同时提供更好的性能
    this.db.run('PRAGMA synchronous = NORMAL');

    this.startFlushInterval();
  }

  /**
   * 异步写入日志（入队）
   * 注意：此方法不等待 flush() 完成，以避免阻塞请求处理
   */
  write(entry: AccessLogEntry): void {
    const pendingRespBodyId = this.pendingRespBodyIdUpdates.get(entry.requestId);
    if (pendingRespBodyId) {
      entry.respBodyId = pendingRespBodyId;
    }
    const pendingOutcome = this.pendingProtocolOutcomeUpdates.get(entry.requestId);
    if (pendingOutcome) {
      entry.protocolOutcome = pendingOutcome.outcome;
      entry.protocolCode = pendingOutcome.code;
      entry.success = pendingOutcome.success;
    }

    this.writeQueue.push(entry);

    // 队列超过 100 条立即刷新（不等待完成）
    if (this.writeQueue.length >= 100) {
      this.flush().catch(err => {
        // 静默处理 flush 错误，避免影响请求处理
        console.error('Background flush failed:', err);
      });
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
    let transactionStarted = false;

    try {
      const insert = this.db.prepare(`
        INSERT OR IGNORE INTO access_logs (
          request_id, timestamp, method, path, query,
          status, duration, route_path, upstream, transformer,
          processing_steps, auth_success, auth_level,
          error_message, req_body_id, resp_body_id, req_header_id, resp_header_id,
          original_req_header_id, original_req_body_id, transformed_path, success, created_at,
          is_failover_attempt, parent_request_id, attempt_number, attempt_upstream, request_type,
          protocol_outcome, protocol_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      this.db.run('BEGIN TRANSACTION');
      transactionStarted = true;

      let insertedCount = 0;
      let ignoredCount = 0;
      const appliedRespBodyUpdates = new Set<string>();
      const appliedProtocolOutcomeUpdates = new Set<string>();

      for (const entry of batch) {
        const pendingRespBodyId = this.pendingRespBodyIdUpdates.get(entry.requestId);
        if (pendingRespBodyId) {
          entry.respBodyId = pendingRespBodyId;
        }
        const pendingOutcome = this.pendingProtocolOutcomeUpdates.get(entry.requestId);
        if (pendingOutcome) {
          entry.protocolOutcome = pendingOutcome.outcome;
          entry.protocolCode = pendingOutcome.code;
          entry.success = pendingOutcome.success;
        }

        const result = insert.run(
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
          entry.success !== undefined ? (entry.success ? 1 : 0) : entry.status < 400 ? 1 : 0,
          Math.floor(entry.timestamp / 1000),
          entry.isFailoverAttempt ? 1 : 0,
          entry.parentRequestId || null,
          entry.attemptNumber || null,
          entry.attemptUpstream || null,
          entry.requestType || 'final',
          entry.protocolOutcome || null,
          entry.protocolCode || null
        );

        // 统计插入和忽略的记录数
        if (result.changes > 0) {
          insertedCount++;
        } else {
          ignoredCount++;
        }

        if (pendingRespBodyId) appliedRespBodyUpdates.add(entry.requestId);
        if (pendingOutcome) appliedProtocolOutcomeUpdates.add(entry.requestId);
      }

      this.db.run('COMMIT');
      transactionStarted = false;
      for (const requestId of appliedRespBodyUpdates) this.pendingRespBodyIdUpdates.delete(requestId);
      for (const requestId of appliedProtocolOutcomeUpdates) this.pendingProtocolOutcomeUpdates.delete(requestId);

      // 如果有记录被忽略，输出警告日志
      if (ignoredCount > 0) {
        console.warn(
          `Batch flush completed: ${insertedCount} inserted, ${ignoredCount} duplicates ignored`
        );
      }
    } catch (error) {
      // 只有在事务已启动且尚未提交时才尝试回滚
      if (transactionStarted) {
        try {
          this.db.run('ROLLBACK');
        } catch (rollbackError) {
          // SQLite 可能已经自动回滚事务，忽略此错误
          // 这是正常行为，不需要记录为错误
        }
      }
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
      this.flush().catch((error) => console.error('Background flush failed:', error));
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
    this.pendingProtocolOutcomeUpdates.clear();
    this.pendingRespBodyIdUpdates.clear();
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

  updateResponseBodyId(requestId: string, respBodyId: string): void {
    if (!requestId || !respBodyId) {
      return;
    }

    if (!this.pendingRespBodyIdUpdates.has(requestId)
      && this.pendingRespBodyIdUpdates.size >= AccessLogWriter.MAX_PENDING_UPDATES) {
      const oldest = this.pendingRespBodyIdUpdates.keys().next().value;
      if (oldest) this.pendingRespBodyIdUpdates.delete(oldest);
    }
    this.pendingRespBodyIdUpdates.set(requestId, respBodyId);

    for (const entry of this.writeQueue) {
      if (entry.requestId === requestId) {
        entry.respBodyId = respBodyId;
      }
    }

    try {
      const result = this.db
        .prepare('UPDATE access_logs SET resp_body_id = ? WHERE request_id = ?')
        .run(respBodyId, requestId);

      if (result.changes > 0) {
        this.pendingRespBodyIdUpdates.delete(requestId);
      }
    } catch (error) {
      this.pendingRespBodyIdUpdates.delete(requestId);
      console.error('Failed to update response body id for streamed log:', {
        requestId,
        respBodyId,
        error,
      });
    }
  }

  updateProtocolOutcome(
    requestId: string,
    outcome: 'completed' | 'failed' | 'incomplete' | 'cancelled',
    success: boolean,
    code?: string,
  ): void {
    if (!requestId) return;
    if (!this.pendingProtocolOutcomeUpdates.has(requestId)
      && this.pendingProtocolOutcomeUpdates.size >= AccessLogWriter.MAX_PENDING_UPDATES) {
      const oldest = this.pendingProtocolOutcomeUpdates.keys().next().value;
      if (oldest) this.pendingProtocolOutcomeUpdates.delete(oldest);
    }
    this.pendingProtocolOutcomeUpdates.set(requestId, { outcome, success, code });
    for (const entry of this.writeQueue) {
      if (entry.requestId === requestId) {
        entry.protocolOutcome = outcome;
        entry.protocolCode = code;
        entry.success = success;
      }
    }
    try {
      const result = this.db.prepare(
        'UPDATE access_logs SET protocol_outcome = ?, protocol_code = ?, success = ? WHERE request_id = ?',
      ).run(outcome, code || null, success ? 1 : 0, requestId);
      if (result.changes > 0) this.pendingProtocolOutcomeUpdates.delete(requestId);
    } catch (error) {
      this.pendingProtocolOutcomeUpdates.delete(requestId);
      console.error('Failed to update protocol outcome for streamed log:', { requestId, outcome, error });
    }
  }
}

// 单例实例
const dbPath = process.env.BUNGEE_ACCESS_DB_PATH ?? path.resolve(process.cwd(), 'logs', 'access.db');
export const accessLogWriter = new AccessLogWriter(dbPath);
