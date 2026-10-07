import { Database } from 'bun:sqlite';
import path from 'path';
import fs from 'fs';
import { initializeAccessDatabaseConnection } from '../access-database';
import type { TransportOutcome } from './transport-outcome';

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
  transportOutcome?: TransportOutcome;
  transportCode?: string;
  /** Only RequestLogger may replace its provisional in-progress entry. */
  replacePendingTransport?: boolean;
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
  private pendingBodyIdUpdates: Map<string, Partial<Pick<AccessLogEntry, 'reqBodyId' | 'respBodyId' | 'originalReqBodyId'>>> = new Map();
  private pendingProtocolOutcomeUpdates: Map<string, { outcome: NonNullable<AccessLogEntry['protocolOutcome']>; success: boolean; code?: string; errorMessage?: string; detailed: boolean }> = new Map();
  private pendingTransportUpdates = new Map<string, { outcome: TransportOutcome; code?: string }>();
  private static readonly MAX_PENDING_UPDATES = 4096;
  private inFlightFlush: Promise<void> | null = null;
  private flushInterval: Timer | null = null;

  constructor(database: Database);
  constructor(dbPath: string);
  constructor(databaseOrPath: Database | string) {
    let database: Database;
    if (typeof databaseOrPath === 'string') {
      const dir = path.dirname(databaseOrPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Schema initialization is owned by the migration system in master.ts.
      database = new Database(databaseOrPath);
    } else {
      database = databaseOrPath;
    }
    try {
      initializeAccessDatabaseConnection(database);
    } catch (error) {
      database.close(true);
      throw error;
    }
    this.db = database;

    this.startFlushInterval();
  }

  /**
   * 异步写入日志（入队）
   * 注意：此方法不等待 flush() 完成，以避免阻塞请求处理
   */
  write(entry: AccessLogEntry): void {
    const pendingBodyIds = this.pendingBodyIdUpdates.get(entry.requestId);
    if (pendingBodyIds) {
      Object.assign(entry, pendingBodyIds);
    }
    const pendingOutcome = this.pendingProtocolOutcomeUpdates.get(entry.requestId);
    if (pendingOutcome) {
      entry.protocolOutcome = pendingOutcome.outcome;
      entry.protocolCode = pendingOutcome.code;
      entry.success = pendingOutcome.success;
      entry.errorMessage = pendingOutcome.detailed ? pendingOutcome.errorMessage : entry.errorMessage ?? pendingOutcome.errorMessage;
    }

    this.applyPendingTransport(entry);
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
    while (true) {
      const inFlightFlush = this.inFlightFlush;
      if (inFlightFlush) {
        await inFlightFlush;
        continue;
      }

      if (this.writeQueue.length === 0) { this.flushPendingTransportUpdates(); return; }

      const nextFlush = Promise.resolve().then(() => this.drainQueue());
      this.inFlightFlush = nextFlush;
      void nextFlush.then(
        () => {
          if (this.inFlightFlush === nextFlush) this.inFlightFlush = null;
        },
        () => {
          if (this.inFlightFlush === nextFlush) this.inFlightFlush = null;
        },
      );
      await nextFlush;
    }
  }

  private async drainQueue(): Promise<void> {
    while (this.writeQueue.length > 0) {
      const batch = this.writeQueue.splice(0);
      await this.flushBatch(batch);
    }
  }

  private async flushBatch(batch: AccessLogEntry[]): Promise<void> {
    let transactionStarted = false;

    try {
      // Database-owned cached statement: survives/invalidates with db lifecycle (Bun .query()).
      const insert = this.db.query(`
        INSERT INTO access_logs (
          request_id, timestamp, method, path, query,
          status, duration, route_path, upstream, transformer,
          processing_steps, auth_success, auth_level,
          error_message, req_body_id, resp_body_id, req_header_id, resp_header_id,
          original_req_header_id, original_req_body_id, transformed_path, success, created_at,
          is_failover_attempt, parent_request_id, attempt_number, attempt_upstream, request_type,
          protocol_outcome, protocol_code, transport_outcome, transport_code
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(request_id) DO UPDATE SET
          timestamp = excluded.timestamp,
          method = excluded.method,
          path = excluded.path,
          query = excluded.query,
          status = excluded.status,
          duration = excluded.duration,
          route_path = excluded.route_path,
          upstream = excluded.upstream,
          transformer = excluded.transformer,
          processing_steps = excluded.processing_steps,
          auth_success = excluded.auth_success,
          auth_level = excluded.auth_level,
          error_message = excluded.error_message,
          req_body_id = excluded.req_body_id,
          resp_body_id = excluded.resp_body_id,
          req_header_id = excluded.req_header_id,
          resp_header_id = excluded.resp_header_id,
          original_req_header_id = excluded.original_req_header_id,
          original_req_body_id = excluded.original_req_body_id,
          transformed_path = excluded.transformed_path,
          success = excluded.success,
          created_at = excluded.created_at,
          is_failover_attempt = excluded.is_failover_attempt,
          parent_request_id = excluded.parent_request_id,
          attempt_number = excluded.attempt_number,
          attempt_upstream = excluded.attempt_upstream,
          request_type = excluded.request_type,
          protocol_outcome = excluded.protocol_outcome,
          protocol_code = excluded.protocol_code,
          transport_outcome = excluded.transport_outcome,
          transport_code = excluded.transport_code
        WHERE ? = 1
      `);

      this.db.run('BEGIN TRANSACTION');
      transactionStarted = true;

      const appliedBodyUpdates = new Set<string>();
      const appliedProtocolOutcomeUpdates = new Set<string>();
      const appliedTransportUpdates = new Set<string>();
      const duplicateRequestIds: string[] = [];

      for (const entry of batch) {
        const pendingBodyIds = this.pendingBodyIdUpdates.get(entry.requestId);
        if (pendingBodyIds) {
          Object.assign(entry, pendingBodyIds);
        }
        const pendingOutcome = this.pendingProtocolOutcomeUpdates.get(entry.requestId);
        if (pendingOutcome) {
          entry.protocolOutcome = pendingOutcome.outcome;
          entry.protocolCode = pendingOutcome.code;
          entry.success = pendingOutcome.success;
          entry.errorMessage = pendingOutcome.detailed ? pendingOutcome.errorMessage : entry.errorMessage ?? pendingOutcome.errorMessage;
        }

        const pendingTransport = this.pendingTransportUpdates.get(entry.requestId);
        this.applyPendingTransport(entry);
        this.db.run('SAVEPOINT access_log_entry');
        try {
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
            entry.protocolCode || null,
            entry.transportOutcome ?? null,
            entry.transportCode ?? null,
            entry.replacePendingTransport ? 1 : 0
          );
          this.db.run('RELEASE SAVEPOINT access_log_entry');

          if (result.changes === 0) duplicateRequestIds.push(entry.requestId);
          if (pendingBodyIds) appliedBodyUpdates.add(entry.requestId);
          if (pendingOutcome) appliedProtocolOutcomeUpdates.add(entry.requestId);
          if (pendingTransport) appliedTransportUpdates.add(entry.requestId);
        } catch (error) {
          this.db.run('ROLLBACK TO SAVEPOINT access_log_entry');
          this.db.run('RELEASE SAVEPOINT access_log_entry');
          if (!isDeterministicEntryError(error)) throw error;
          console.error('Dropped invalid access log entry:', { requestId: entry.requestId, error });
        }
      }

      this.db.run('COMMIT');
      transactionStarted = false;
      for (const requestId of appliedBodyUpdates) this.pendingBodyIdUpdates.delete(requestId);
      for (const requestId of appliedProtocolOutcomeUpdates) this.pendingProtocolOutcomeUpdates.delete(requestId);
      for (const requestId of appliedTransportUpdates) this.pendingTransportUpdates.delete(requestId);
      if (duplicateRequestIds.length > 0) {
        console.warn('Skipped duplicate access log entries:', { requestIds: duplicateRequestIds });
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
      throw error;
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
    this.pendingBodyIdUpdates.clear();
    this.pendingTransportUpdates.clear();
    this.db.close(true);
  }

  /**
   * 获取数据库实例（只读）
   */
  getDatabase(): Database {
    return this.db;
  }

  updateResponseBodyId(requestId: string, respBodyId: string): void {
    this.updateBodyId(requestId, 'response', respBodyId);
  }

  updateBodyId(requestId: string, type: 'request' | 'response' | 'original-request', bodyId: string): void {
    if (!requestId || !bodyId) return;
    const fields = { request: ['reqBodyId', 'req_body_id'], response: ['respBodyId', 'resp_body_id'],
      'original-request': ['originalReqBodyId', 'original_req_body_id'] } as const;
    const [field, column] = fields[type];
    if (!this.pendingBodyIdUpdates.has(requestId)
      && this.pendingBodyIdUpdates.size >= AccessLogWriter.MAX_PENDING_UPDATES) {
      const oldest = this.pendingBodyIdUpdates.keys().next().value;
      if (oldest) this.pendingBodyIdUpdates.delete(oldest);
    }
    const updates = { ...this.pendingBodyIdUpdates.get(requestId), [field]: bodyId };
    this.pendingBodyIdUpdates.set(requestId, updates);
    for (const entry of this.writeQueue) if (entry.requestId === requestId) Object.assign(entry, updates);
    try {
      const result = this.db.query(`UPDATE access_logs SET ${column} = ? WHERE request_id = ?`).run(bodyId, requestId);
      if (result.changes > 0) this.pendingBodyIdUpdates.delete(requestId);
    } catch (error) {
      this.pendingBodyIdUpdates.delete(requestId);
      console.error('Failed to update captured body id:', { requestId, type, error });
    }
  }

  private flushPendingTransportUpdates(): void {
    if (this.pendingTransportUpdates.size === 0) return;
    const update = this.db.query('UPDATE access_logs SET transport_outcome = ?, transport_code = ? WHERE request_id = ?');
    for (const [requestId, pending] of this.pendingTransportUpdates) {
      const result = update.run(pending.outcome, pending.code ?? null, requestId);
      if (result.changes > 0) this.pendingTransportUpdates.delete(requestId);
    }
  }

  private applyPendingTransport(entry: AccessLogEntry): void {
    const pending = this.pendingTransportUpdates.get(entry.requestId);
    if (pending) { entry.transportOutcome = pending.outcome; entry.transportCode = pending.code; }
  }

  updateTransportOutcome(requestId: string, outcome: TransportOutcome, code?: string): void {
    if (!requestId) return;
    if (!this.pendingTransportUpdates.has(requestId) && this.pendingTransportUpdates.size >= AccessLogWriter.MAX_PENDING_UPDATES) {
      const oldest = this.pendingTransportUpdates.keys().next().value;
      if (oldest) this.pendingTransportUpdates.delete(oldest);
    }
    this.pendingTransportUpdates.set(requestId, { outcome, code });
    for (const entry of this.writeQueue) if (entry.requestId === requestId) this.applyPendingTransport(entry);
    try {
      const result = this.db.query('UPDATE access_logs SET transport_outcome = ?, transport_code = ? WHERE request_id = ?')
        .run(outcome, code ?? null, requestId);
      if (result.changes > 0) this.pendingTransportUpdates.delete(requestId);
    } catch (error) {
      // Retain the bounded update for a later write/flush, unlike a lost late stream outcome.
      console.error('Failed to update transport outcome:', { requestId, outcome, error });
    }
  }

  appendProcessingStep(requestId: string, step: ProcessingStep): void {
    for (const entry of this.writeQueue) {
      if (entry.requestId !== requestId) continue;
      entry.processingSteps ??= [];
      if (!entry.processingSteps.includes(step)) entry.processingSteps.push(step);
    }
    try {
      this.db.query("UPDATE access_logs SET processing_steps=json_insert(COALESCE(processing_steps,'[]'),'$[#]',json(?)) WHERE request_id=?")
        .run(JSON.stringify(step), requestId);
    } catch (error) { console.error('Failed to append body logging diagnostic:', { requestId, error }); }
  }

  updateProtocolOutcome(
    requestId: string,
    outcome: 'completed' | 'failed' | 'incomplete' | 'cancelled',
    success: boolean,
    code?: string,
    diagnosticMessage?: string,
  ): void {
    if (!requestId) return;
    if (!this.pendingProtocolOutcomeUpdates.has(requestId)
      && this.pendingProtocolOutcomeUpdates.size >= AccessLogWriter.MAX_PENDING_UPDATES) {
      const oldest = this.pendingProtocolOutcomeUpdates.keys().next().value;
      if (oldest) this.pendingProtocolOutcomeUpdates.delete(oldest);
    }
    const errorMessage = diagnosticMessage ?? (outcome === 'failed' || outcome === 'incomplete'
      ? `Response stream ${outcome}${code ? ` (${code})` : ''}`
      : undefined);
    const detailed = diagnosticMessage !== undefined;
    this.pendingProtocolOutcomeUpdates.set(requestId, { outcome, success, code, errorMessage, detailed });
    for (const entry of this.writeQueue) {
      if (entry.requestId === requestId) {
        entry.protocolOutcome = outcome;
        entry.protocolCode = code;
        entry.success = success;
        entry.errorMessage = detailed ? errorMessage : entry.errorMessage ?? errorMessage;
      }
    }
    try {
      const result = this.db.query(
        'UPDATE access_logs SET protocol_outcome = ?, protocol_code = ?, success = ?, error_message = CASE WHEN ? THEN ? ELSE COALESCE(error_message, ?) END WHERE request_id = ?',
      ).run(outcome, code || null, success ? 1 : 0, detailed ? 1 : 0, errorMessage ?? null, errorMessage ?? null, requestId);
      if (result.changes > 0) this.pendingProtocolOutcomeUpdates.delete(requestId);
    } catch (error) {
      this.pendingProtocolOutcomeUpdates.delete(requestId);
      console.error('Failed to update protocol outcome for streamed log:', { requestId, outcome, error });
    }
  }
}

function isDeterministicEntryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /constraint failed|datatype mismatch/i.test(message);
}

// 单例实例
const dbPath = process.env.BUNGEE_ACCESS_DB_PATH ?? path.resolve(process.cwd(), 'logs', 'access.db');
export const accessLogWriter = new AccessLogWriter(dbPath);
