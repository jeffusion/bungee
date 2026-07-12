import { accessLogWriter, type ProcessingStep } from '../logger/access-log-writer';
import type { Database } from 'bun:sqlite';

export interface LogQueryParams {
  // Pagination
  page?: number;
  limit?: number;

  // Filtering
  startTime?: number; // timestamp in ms
  endTime?: number;
  method?: string;
  path?: string;
  status?: number | number[];
  routePath?: string;
  upstream?: string;
  transformer?: string;
  success?: boolean;
  searchTerm?: string; // search in path, error_message
  requestType?: 'final' | 'retry' | 'recovery'; // request type classification

  // Sorting
  sortBy?: 'timestamp' | 'duration' | 'status';
  sortOrder?: 'asc' | 'desc';

  // Chain-only filters (applied only when groupBy='chain' — ignored otherwise)
  hasRetry?: boolean;
  chainStatusMin?: number;
  chainStatusMax?: number;
  minChainDurationMs?: number;
  maxChainDurationMs?: number;
}

export interface LogEntry {
  id: number;
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
  transformedPath?: string;       // 转换后的路径（经过 path_rewrite）
  processingSteps?: ProcessingStep[];
  authSuccess: boolean;
  authLevel?: string;
  errorMessage?: string;
  success: boolean;
  reqBodyId?: string;
  respBodyId?: string;
  reqHeaderId?: string;
  respHeaderId?: string;
  originalReqHeaderId?: string;  // 原始请求头 ID（转换前）
  originalReqBodyId?: string;     // 原始请求体 ID（转换前）
  requestType?: 'final' | 'retry' | 'recovery';  // 请求类型分类

  // Failover tracking (existing in DB, newly exposed via API)
  isFailoverAttempt?: boolean;
  parentRequestId?: string;
  attemptNumber?: number;
  attemptUpstream?: string;
}

export interface ChainEntry extends LogEntry {
  chainId: string;                              // = COALESCE(parent_request_id, request_id)
  chainAttempts: number;                         // COUNT(*) by chainId
  chainDurationMs: number;                       // chainEndTs - chainStartTs
  chainStatus: number;                           // 最后 request_type='final' 的 status，fallback 按 attempt_number DESC, timestamp DESC
  chainStartTs: number;                          // MIN(timestamp) of chain rows
  chainEndTs: number;                            // MAX(timestamp+duration) of chain rows
  hasRetry: boolean;                             // 存在 is_failover_attempt=1 的 row
  chainUpstreams?: string[];                     // 列表 SQL 不拉取（详情阶段填）
}

export interface ChainQueryResult {
  data: ChainEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

export interface ChainDetail {
  chain: ChainEntry;
  attempts: LogEntry[];
}

export interface LogQueryResult {
  data: LogEntry[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * 日志查询服务
 *
 * 提供查询、过滤、排序、导出等功能
 */
export class LogQueryService {
  private db: Database;

  // chain 模式 sortBy 白名单 → SQL alias 映射，禁止任何前端字符串直接拼 SQL ORDER BY
  private static readonly CHAIN_SORT_COLUMNS: Readonly<Record<'timestamp' | 'duration' | 'status', string>> = {
    timestamp: 'chain_start_ts',
    duration: 'chain_duration_ms',
    status: 'chain_status',
  };

  constructor(db?: Database) {
    this.db = db ?? accessLogWriter.getDatabase();
  }

  /**
   * 查询日志（分页、过滤、排序）
   */
  async query(params: LogQueryParams = {}): Promise<LogQueryResult> {
    const {
      page = 1,
      limit = 50,
      startTime,
      endTime,
      method,
      path,
      status,
      routePath,
      upstream,
      transformer,
      success,
      searchTerm,
      requestType,
      sortBy = 'timestamp',
      sortOrder = 'desc',
    } = params;

    // Build WHERE clause
    const whereClauses: string[] = [];
    const whereParams: any[] = [];

    if (startTime) {
      whereClauses.push('timestamp >= ?');
      whereParams.push(startTime);
    }
    if (endTime) {
      whereClauses.push('timestamp <= ?');
      whereParams.push(endTime);
    }
    if (method) {
      whereClauses.push('method = ?');
      whereParams.push(method);
    }
    if (path) {
      whereClauses.push('path LIKE ?');
      whereParams.push(`%${path}%`);
    }
    if (status !== undefined) {
      if (Array.isArray(status)) {
        whereClauses.push(`status IN (${status.map(() => '?').join(', ')})`);
        whereParams.push(...status);
      } else {
        whereClauses.push('status = ?');
        whereParams.push(status);
      }
    }
    if (routePath) {
      whereClauses.push('route_path = ?');
      whereParams.push(routePath);
    }
    if (upstream) {
      whereClauses.push('upstream LIKE ?');
      whereParams.push(`%${upstream}%`);
    }
    if (transformer) {
      whereClauses.push('transformer = ?');
      whereParams.push(transformer);
    }
    if (success !== undefined) {
      whereClauses.push('success = ?');
      whereParams.push(success ? 1 : 0);
    }
    if (searchTerm) {
      whereClauses.push('(path LIKE ? OR error_message LIKE ?)');
      whereParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }
    if (requestType) {
      whereClauses.push('request_type = ?');
      whereParams.push(requestType);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM access_logs ${whereClause}`;
    const countResult = this.db.prepare(countQuery).get(...whereParams) as { total: number };
    const total = countResult.total;

    // Get paginated data
    const offset = (page - 1) * limit;
    const sortColumn = sortBy === 'timestamp' ? 'timestamp' : sortBy === 'duration' ? 'duration' : 'status';
    const order = sortOrder.toUpperCase();

    const dataQuery = `
      SELECT * FROM access_logs
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(dataQuery).all(...whereParams, limit, offset) as any[];

    const data = rows.map(row => this.mapRowToLogEntry(row));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 根据 Request ID 获取单条日志
   */
  async getById(requestId: string): Promise<LogEntry | null> {
    const query = 'SELECT * FROM access_logs WHERE request_id = ?';
    const row = this.db.prepare(query).get(requestId) as any;

    if (!row) {
      return null;
    }

    return this.mapRowToLogEntry(row);
  }

  /**
   * Chain 维度查询：按 COALESCE(parent_request_id, request_id) 聚合
   * 两阶段 CTE：先找命中的 chainId，再对这些 chain 的完整 rows 聚合
   * chain-level filter（chainStatus/hasRetry/chainDurationMs）在 agg CTE 之后做
   */
  async queryChains(params: LogQueryParams = {}): Promise<ChainQueryResult> {
    const {
      page = 1,
      limit = 50,
      startTime,
      endTime,
      method,
      path,
      status,
      routePath,
      upstream,
      transformer,
      success,
      searchTerm,
      requestType,
      sortBy = 'timestamp',
      sortOrder = 'desc',
      hasRetry,
      chainStatusMin,
      chainStatusMax,
      minChainDurationMs,
      maxChainDurationMs,
    } = params;

    // row-level filters — 任一 attempt 命中即整 chain 命中
    const rowWhereClauses: string[] = [];
    const rowWhereParams: any[] = [];

    if (startTime) {
      rowWhereClauses.push('timestamp >= ?');
      rowWhereParams.push(startTime);
    }
    if (endTime) {
      rowWhereClauses.push('timestamp <= ?');
      rowWhereParams.push(endTime);
    }
    if (method) {
      rowWhereClauses.push('method = ?');
      rowWhereParams.push(method);
    }
    if (path) {
      rowWhereClauses.push('path LIKE ?');
      rowWhereParams.push(`%${path}%`);
    }
    if (routePath) {
      rowWhereClauses.push('route_path = ?');
      rowWhereParams.push(routePath);
    }
    if (upstream) {
      // chain 模式下用 COALESCE 表达式覆盖 attempt_upstream 老 row
      rowWhereClauses.push("COALESCE(NULLIF(attempt_upstream, ''), upstream) LIKE ?");
      rowWhereParams.push(`%${upstream}%`);
    }
    if (transformer) {
      rowWhereClauses.push('transformer = ?');
      rowWhereParams.push(transformer);
    }
    if (searchTerm) {
      rowWhereClauses.push('(path LIKE ? OR error_message LIKE ?)');
      rowWhereParams.push(`%${searchTerm}%`, `%${searchTerm}%`);
    }
    if (requestType) {
      rowWhereClauses.push('request_type = ?');
      rowWhereParams.push(requestType);
    }

    const rowWhereClause = rowWhereClauses.length > 0 ? `WHERE ${rowWhereClauses.join(' AND ')}` : '';

    // chain-level filters — agg 之后做
    const chainWhereClauses: string[] = [];
    const chainWhereParams: any[] = [];

    if (status !== undefined) {
      // chain 模式下 status 按 chainStatus 派生
      if (Array.isArray(status)) {
        chainWhereClauses.push(`chain_status IN (${status.map(() => '?').join(', ')})`);
        chainWhereParams.push(...status);
      } else {
        chainWhereClauses.push('chain_status = ?');
        chainWhereParams.push(status);
      }
    }
    if (success !== undefined) {
      // chain 模式下 success 按 chainStatus < 400 派生
      chainWhereClauses.push(success ? 'chain_status < 400' : 'chain_status >= 400');
    }
    if (hasRetry !== undefined) {
      chainWhereClauses.push('has_retry = ?');
      chainWhereParams.push(hasRetry ? 1 : 0);
    }
    if (chainStatusMin !== undefined) {
      chainWhereClauses.push('chain_status >= ?');
      chainWhereParams.push(chainStatusMin);
    }
    if (chainStatusMax !== undefined) {
      chainWhereClauses.push('chain_status <= ?');
      chainWhereParams.push(chainStatusMax);
    }
    if (minChainDurationMs !== undefined) {
      chainWhereClauses.push('chain_duration_ms >= ?');
      chainWhereParams.push(minChainDurationMs);
    }
    if (maxChainDurationMs !== undefined) {
      chainWhereClauses.push('chain_duration_ms <= ?');
      chainWhereParams.push(maxChainDurationMs);
    }

    const sortColumn = LogQueryService.CHAIN_SORT_COLUMNS[sortBy] ?? LogQueryService.CHAIN_SORT_COLUMNS.timestamp;
    const sortDirection = sortOrder === 'asc' ? 'ASC' : 'DESC';

    const chainWhereClause = chainWhereClauses.length > 0 ? `WHERE ${chainWhereClauses.join(' AND ')}` : '';

    const countQuery = `
      WITH filtered_chain_ids AS (
        SELECT DISTINCT COALESCE(parent_request_id, request_id) AS chain_id
        FROM access_logs
        ${rowWhereClause}
      ),
      chain_rows AS (
        SELECT
          al.*,
          COALESCE(al.parent_request_id, al.request_id) AS chain_id,
          al.timestamp + al.duration AS end_ts,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(al.parent_request_id, al.request_id)
            ORDER BY
              CASE WHEN al.attempt_number IS NULL THEN 0 ELSE 1 END,
              al.attempt_number ASC,
              al.timestamp ASC,
              al.id ASC
          ) AS rep_rank,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(al.parent_request_id, al.request_id)
            ORDER BY
              CASE WHEN al.request_type = 'final' THEN 0 ELSE 1 END,
              CASE WHEN al.attempt_number IS NULL THEN -1 ELSE al.attempt_number END DESC,
              al.timestamp DESC,
              al.id DESC
          ) AS status_rank
        FROM access_logs al
        JOIN filtered_chain_ids f ON f.chain_id = COALESCE(al.parent_request_id, al.request_id)
      ),
      agg AS (
        SELECT
          chain_id,
          MIN(timestamp) AS chain_start_ts,
          MAX(end_ts) AS chain_end_ts,
          COUNT(*) AS chain_attempts,
          MAX(CASE WHEN is_failover_attempt = 1 THEN 1 ELSE 0 END) AS has_retry,
          MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
          (MAX(end_ts) - MIN(timestamp)) AS chain_duration_ms
        FROM chain_rows
        GROUP BY chain_id
      )
      SELECT COUNT(*) AS total FROM agg ${chainWhereClause}
    `;
    const countParams = [...rowWhereParams, ...chainWhereParams];
    const countResult = this.db.prepare(countQuery).get(...countParams) as { total: number };
    const total = countResult.total;

    const offset = Math.max(0, (page - 1) * limit);
    const dataQuery = `
      WITH filtered_chain_ids AS (
        SELECT DISTINCT COALESCE(parent_request_id, request_id) AS chain_id
        FROM access_logs
        ${rowWhereClause}
      ),
      chain_rows AS (
        SELECT
          al.*,
          COALESCE(al.parent_request_id, al.request_id) AS chain_id,
          al.timestamp + al.duration AS end_ts,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(al.parent_request_id, al.request_id)
            ORDER BY
              CASE WHEN al.attempt_number IS NULL THEN 0 ELSE 1 END,
              al.attempt_number ASC,
              al.timestamp ASC,
              al.id ASC
          ) AS rep_rank,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(al.parent_request_id, al.request_id)
            ORDER BY
              CASE WHEN al.request_type = 'final' THEN 0 ELSE 1 END,
              CASE WHEN al.attempt_number IS NULL THEN -1 ELSE al.attempt_number END DESC,
              al.timestamp DESC,
              al.id DESC
          ) AS status_rank
        FROM access_logs al
        JOIN filtered_chain_ids f ON f.chain_id = COALESCE(al.parent_request_id, al.request_id)
      ),
      agg AS (
        SELECT
          chain_id,
          MIN(timestamp) AS chain_start_ts,
          MAX(end_ts) AS chain_end_ts,
          COUNT(*) AS chain_attempts,
          MAX(CASE WHEN is_failover_attempt = 1 THEN 1 ELSE 0 END) AS has_retry,
          MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
          (MAX(end_ts) - MIN(timestamp)) AS chain_duration_ms
        FROM chain_rows
        GROUP BY chain_id
      )
      SELECT
        rep.*,
        agg.chain_start_ts,
        agg.chain_end_ts,
        agg.chain_attempts,
        agg.has_retry,
        agg.chain_status,
        agg.chain_duration_ms
      FROM agg
      JOIN chain_rows rep ON rep.chain_id = agg.chain_id AND rep.rep_rank = 1
      ${chainWhereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT ? OFFSET ?
    `;
    const dataParams = [...rowWhereParams, ...chainWhereParams, limit, offset];
    const rows = this.db.prepare(dataQuery).all(...dataParams) as any[];

    const data: ChainEntry[] = rows.map(row => ({
      ...this.mapRowToLogEntry(row),
      chainId: row.chain_id,
      chainAttempts: row.chain_attempts,
      chainDurationMs: row.chain_duration_ms,
      chainStatus: row.chain_status,
      chainStartTs: row.chain_start_ts,
      chainEndTs: row.chain_end_ts,
      hasRetry: row.has_retry === 1,
    }));

    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * 取 chain 内 unique upstream list（GROUP BY target）
   */
  async getChainUpstreams(chainId: string): Promise<Array<{ target: string; firstAttempt: number; firstTs: number; count: number }>> {
    const query = `
      SELECT
        COALESCE(NULLIF(attempt_upstream, ''), upstream) AS target,
        MIN(COALESCE(attempt_number, 0)) AS first_attempt,
        MIN(timestamp) AS first_ts,
        COUNT(*) AS count
      FROM access_logs
      WHERE parent_request_id = ? OR request_id = ?
      GROUP BY target
      ORDER BY first_attempt, first_ts
    `;
    const rows = this.db.prepare(query).all(chainId, chainId) as any[];
    return rows.map(row => ({
      target: row.target,
      firstAttempt: row.first_attempt,
      firstTs: row.first_ts,
      count: row.count,
    }));
  }

  /**
   * Chain detail：返回 chain meta + attempts 数组
   */
  async getChainDetail(chainId: string): Promise<ChainDetail | null> {
    const query = `
      SELECT * FROM access_logs
      WHERE parent_request_id = ? OR request_id = ?
      ORDER BY
        CASE WHEN attempt_number IS NULL THEN 0 ELSE 1 END,
        attempt_number ASC,
        timestamp ASC,
        id ASC
    `;
    const rows = this.db.prepare(query).all(chainId, chainId) as any[];

    if (rows.length === 0) {
      return null;
    }

    const attempts = rows.map(row => this.mapRowToLogEntry(row));

    const chainStartTs = Math.min(...attempts.map(a => a.timestamp));
    const chainEndTs = Math.max(...attempts.map(a => a.timestamp + a.duration));
    const chainAttempts = attempts.length;
    const hasRetry = attempts.some(a => a.isFailoverAttempt);

    // chainStatus：最后 request_type='final' 的 status，否则按 attempt_number DESC, timestamp DESC, id DESC 取最后一条
    const finalRows = attempts.filter(a => a.requestType === 'final');
    let chainStatus: number;
    if (finalRows.length > 0) {
      const finalSorted = finalRows.sort((a, b) => {
        const aNum = a.attemptNumber ?? -1;
        const bNum = b.attemptNumber ?? -1;
        if (bNum !== aNum) return bNum - aNum;
        if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
        return b.id - a.id;
      });
      chainStatus = finalSorted[0].status;
    } else {
      const sorted = attempts.sort((a, b) => {
        const aNum = a.attemptNumber ?? -1;
        const bNum = b.attemptNumber ?? -1;
        if (bNum !== aNum) return bNum - aNum;
        if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
        return b.id - a.id;
      });
      chainStatus = sorted[0].status;
    }

    // 代表 row = attemptNumber 最小（或 NULL）的 row — attempts 已按 attempt_number NULLS FIRST 排序，attempts[0] 即代表 row
    const repRow = attempts[0];
    const upstreamsData = await this.getChainUpstreams(chainId);

    const chain: ChainEntry = {
      ...repRow,
      chainId,
      chainAttempts,
      chainDurationMs: chainEndTs - chainStartTs,
      chainStatus,
      chainStartTs,
      chainEndTs,
      hasRetry,
      chainUpstreams: upstreamsData.map(u => u.target),
    };

    return {
      chain,
      attempts,
    };
  }

  /**
   * 实时日志流（SSE）
   *
   * 使用方式：
   * ```typescript
   * for await (const log of logQueryService.streamLogs()) {
   *   // Send to SSE client
   * }
   * ```
   */
  async *streamLogs(pollInterval: number = 1000): AsyncGenerator<LogEntry> {
    let lastTimestamp = Date.now();

    while (true) {
      // Query new logs since last poll
      const query = `
        SELECT * FROM access_logs
        WHERE timestamp > ?
        ORDER BY timestamp ASC
      `;
      const rows = this.db.prepare(query).all(lastTimestamp) as any[];

      for (const row of rows) {
        const entry = this.mapRowToLogEntry(row);
        lastTimestamp = entry.timestamp;
        yield entry;
      }

      // Wait before next poll
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }
  }

  /**
   * 导出日志
   */
  async exportLogs(params: LogQueryParams = {}, format: 'json' | 'csv' = 'json'): Promise<string> {
    // Query all logs matching criteria (no pagination)
    const result = await this.query({ ...params, limit: 999999, page: 1 });

    if (format === 'json') {
      return JSON.stringify(result.data, null, 2);
    }

    // CSV format
    if (result.data.length === 0) {
      return '';
    }

    const headers = [
      'requestId', 'timestamp', 'method', 'path', 'query', 'status', 'duration',
      'routePath', 'upstream', 'transformer', 'authSuccess', 'authLevel',
      'errorMessage', 'success', 'requestType'
    ];

    const csvRows = [
      headers.join(','),
      ...result.data.map(entry => {
        return [
          entry.requestId,
          new Date(entry.timestamp).toISOString(),
          entry.method,
          `"${entry.path}"`,
          entry.query ? `"${entry.query}"` : '',
          entry.status,
          entry.duration,
          entry.routePath || '',
          entry.upstream || '',
          entry.transformer || '',
          entry.authSuccess ? 'true' : 'false',
          entry.authLevel || '',
          entry.errorMessage ? `"${entry.errorMessage.replace(/"/g, '""')}"` : '',
          entry.success ? 'true' : 'false',
          entry.requestType || 'final',
        ].join(',');
      })
    ];

    return csvRows.join('\n');
  }

  /**
   * 获取统计数据（用于 Dashboard）
   */
  async getStats(startTime?: number, endTime?: number): Promise<{
    totalRequests: number;
    successRequests: number;
    failedRequests: number;
    avgResponseTime: number;
  }> {
    const whereClauses: string[] = [];
    const params: any[] = [];

    if (startTime) {
      whereClauses.push('timestamp >= ?');
      params.push(startTime);
    }
    if (endTime) {
      whereClauses.push('timestamp <= ?');
      params.push(endTime);
    }

    const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const query = `
      WITH chain_rows AS (
        SELECT
          COALESCE(parent_request_id, request_id) AS chain_id,
          timestamp, duration, status,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(parent_request_id, request_id)
            ORDER BY
              CASE WHEN request_type = 'final' THEN 0 ELSE 1 END,
              CASE WHEN attempt_number IS NULL THEN -1 ELSE attempt_number END DESC,
              timestamp DESC,
              id DESC
          ) AS status_rank
        FROM access_logs
        ${whereClause}
      ),
      chains AS (
        SELECT
          chain_id,
          MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
          (MAX(timestamp + duration) - MIN(timestamp)) AS chain_duration_ms
        FROM chain_rows
        GROUP BY chain_id
      )
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN chain_status < 400 THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN chain_status >= 400 THEN 1 ELSE 0 END) AS failed_requests,
        AVG(chain_duration_ms) AS avg_response_time
      FROM chains
    `;

    const result = this.db.prepare(query).get(...params) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      failedRequests: result.failed_requests || 0,
      avgResponseTime: result.avg_response_time || 0,
    };
  }

  /**
   * 获取时间序列统计数据（用于图表）
   */
  async getTimeSeriesStats(
    startTime: number,
    endTime: number,
    interval: 'minute' | '30min' | 'hour' | 'day' = 'minute'
  ): Promise<Array<{
    timestamp: number;
    totalRequests: number;
    successRequests: number;
    failedRequests: number;
    avgResponseTime: number;
  }>> {
    // Calculate interval in seconds
    const intervalSeconds =
      interval === 'minute' ? 60 :
      interval === '30min' ? 1800 :
      interval === 'hour' ? 3600 :
      86400;

    const query = `
      WITH chain_rows AS (
        SELECT
          COALESCE(parent_request_id, request_id) AS chain_id,
          timestamp, duration, status,
          ROW_NUMBER() OVER (
            PARTITION BY COALESCE(parent_request_id, request_id)
            ORDER BY
              CASE WHEN request_type = 'final' THEN 0 ELSE 1 END,
              CASE WHEN attempt_number IS NULL THEN -1 ELSE attempt_number END DESC,
              timestamp DESC,
              id DESC
          ) AS status_rank
        FROM access_logs
        WHERE timestamp >= ? AND timestamp <= ?
      ),
      chains AS (
        SELECT
          chain_id,
          (MIN(timestamp) / ${intervalSeconds * 1000}) * ${intervalSeconds * 1000} AS bucket,
          MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
          (MAX(timestamp + duration) - MIN(timestamp)) AS chain_duration_ms
        FROM chain_rows
        GROUP BY chain_id
      )
      SELECT
        bucket,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN chain_status < 400 THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN chain_status >= 400 THEN 1 ELSE 0 END) AS failed_requests,
        AVG(chain_duration_ms) AS avg_response_time
      FROM chains
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const rows = this.db.prepare(query).all(startTime, endTime) as any[];

    const dataPoints = rows.map(row => ({
      timestamp: row.bucket,
      totalRequests: row.total_requests,
      successRequests: row.success_requests,
      failedRequests: row.failed_requests,
      avgResponseTime: row.avg_response_time,
    }));

    // Fill missing time points with zero values
    return this.fillMissingTimePoints(dataPoints, startTime, endTime, intervalSeconds * 1000);
  }

  /**
   * 获取 Endpoint 请求分布统计
   */
  async getUpstreamDistribution(startTime: number, endTime: number, limit: number = 10): Promise<Array<{
    upstream: string;
    count: number;
    percentage: number;
  }>> {
    const query = `
      SELECT
        upstream,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM access_logs WHERE timestamp >= ? AND timestamp <= ? AND upstream IS NOT NULL), 2) as percentage
      FROM access_logs
      WHERE timestamp >= ? AND timestamp <= ?
        AND upstream IS NOT NULL
      GROUP BY upstream
      ORDER BY count DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(startTime, endTime, startTime, endTime, limit) as any[];

    return rows.map(row => ({
      upstream: row.upstream,
      count: row.count,
      percentage: row.percentage || 0,
    }));
  }

  /**
   * 获取 Endpoint 失败统计
   */
  async getUpstreamFailureStats(startTime: number, endTime: number, limit: number = 10): Promise<Array<{
    upstream: string;
    totalRequests: number;
    failedRequests: number;
    successRequests: number;
    failureRate: number;
  }>> {
    const query = `
      SELECT
        upstream,
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
        ROUND(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) * 100.0 / COUNT(*), 2) as failure_rate
      FROM access_logs
      WHERE timestamp >= ? AND timestamp <= ?
        AND upstream IS NOT NULL
      GROUP BY upstream
      ORDER BY failure_rate DESC, total_requests DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(startTime, endTime, limit) as any[];

    return rows.map(row => ({
      upstream: row.upstream,
      totalRequests: row.total_requests,
      failedRequests: row.failed_requests,
      successRequests: row.success_requests,
      failureRate: row.failure_rate || 0,
    }));
  }

  /**
   * 获取统一的 Endpoint 统计（支持全部/成功/失败过滤）
   */
  async getUnifiedUpstreamStats(startTime: number, endTime: number, type: 'all' | 'success' | 'failure' = 'all', limit: number = 10): Promise<Array<{
    upstream: string;
    count: number;
    percentage: number;
    totalRequests: number;
    successRequests: number;
    failedRequests: number;
    failureRate: number;
  }>> {
    const successFilter = type === 'success' ? 'AND success = 1' : type === 'failure' ? 'AND success = 0' : '';

    const query = `
      SELECT
        upstream,
        COUNT(*) as count,
        ROUND(COUNT(*) * 100.0 / (SELECT COUNT(*) FROM access_logs WHERE timestamp >= ? AND timestamp <= ? AND upstream IS NOT NULL ${successFilter}), 2) as percentage,
        (SELECT COUNT(*) FROM access_logs al WHERE al.upstream = access_logs.upstream AND al.timestamp >= ? AND al.timestamp <= ?) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
        ROUND(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) * 100.0 / (SELECT COUNT(*) FROM access_logs al WHERE al.upstream = access_logs.upstream AND al.timestamp >= ? AND al.timestamp <= ?), 2) as failure_rate
      FROM access_logs
      WHERE timestamp >= ? AND timestamp <= ?
        AND upstream IS NOT NULL
        ${successFilter}
      GROUP BY upstream
      ORDER BY count DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(startTime, endTime, startTime, endTime, startTime, endTime, startTime, endTime, limit) as any[];

    return rows.map(row => ({
      upstream: row.upstream,
      count: row.count,
      percentage: row.percentage || 0,
      totalRequests: row.total_requests,
      successRequests: row.success_requests,
      failedRequests: row.failed_requests,
      failureRate: row.failure_rate || 0,
    }));
  }

  /**
   * 获取 Endpoint 状态码统计
   */
  async getUpstreamStatusCodeStats(startTime: number, endTime: number, limit: number = 10): Promise<Array<{
    upstream: string;
    status2xx: number;
    status3xx: number;
    status4xx: number;
    status5xx: number;
    totalRequests: number;
  }>> {
    const query = `
      SELECT
        upstream,
        COUNT(*) as total_requests,
        SUM(CASE WHEN status >= 200 AND status < 300 THEN 1 ELSE 0 END) as status_2xx,
        SUM(CASE WHEN status >= 300 AND status < 400 THEN 1 ELSE 0 END) as status_3xx,
        SUM(CASE WHEN status >= 400 AND status < 500 THEN 1 ELSE 0 END) as status_4xx,
        SUM(CASE WHEN status >= 500 AND status < 600 THEN 1 ELSE 0 END) as status_5xx
      FROM access_logs
      WHERE timestamp >= ? AND timestamp <= ?
        AND upstream IS NOT NULL
      GROUP BY upstream
      ORDER BY total_requests DESC
      LIMIT ?
    `;

    const rows = this.db.prepare(query).all(startTime, endTime, limit) as any[];

    return rows.map(row => ({
      upstream: row.upstream,
      status2xx: row.status_2xx,
      status3xx: row.status_3xx,
      status4xx: row.status_4xx,
      status5xx: row.status_5xx,
      totalRequests: row.total_requests,
    }));
  }

  /**
   * 填充缺失的时间点，确保图表数据连续
   */
  private fillMissingTimePoints(
    dataPoints: Array<{
      timestamp: number;
      totalRequests: number;
      successRequests: number;
      failedRequests: number;
      avgResponseTime: number;
    }>,
    startTime: number,
    endTime: number,
    intervalMs: number
  ): Array<{
    timestamp: number;
    totalRequests: number;
    successRequests: number;
    failedRequests: number;
    avgResponseTime: number;
  }> {
    // Create a map of existing data points
    const dataMap = new Map<number, typeof dataPoints[0]>();
    for (const point of dataPoints) {
      dataMap.set(point.timestamp, point);
    }

    // Generate complete time series
    const result: typeof dataPoints = [];

    // Align startTime to interval boundary
    const alignedStart = Math.floor(startTime / intervalMs) * intervalMs;

    for (let timestamp = alignedStart; timestamp <= endTime; timestamp += intervalMs) {
      if (dataMap.has(timestamp)) {
        // Use actual data
        result.push(dataMap.get(timestamp)!);
      } else {
        // Fill with zeros
        result.push({
          timestamp,
          totalRequests: 0,
          successRequests: 0,
          failedRequests: 0,
          avgResponseTime: 0,
        });
      }
    }

    return result;
  }

  /**
   * 将数据库行映射为 LogEntry 对象
   */
  private mapRowToLogEntry(row: any): LogEntry {
    return {
      id: row.id,
      requestId: row.request_id,
      timestamp: row.timestamp,
      method: row.method,
      path: row.path,
      query: row.query || undefined,
      status: row.status,
      duration: row.duration,
      routePath: row.route_path || undefined,
      upstream: row.upstream || undefined,
      transformer: row.transformer || undefined,
      processingSteps: row.processing_steps ? JSON.parse(row.processing_steps) : undefined,
      authSuccess: row.auth_success === 1,
      authLevel: row.auth_level || undefined,
      errorMessage: row.error_message || undefined,
      success: row.success === 1,
      reqBodyId: row.req_body_id || undefined,
      respBodyId: row.resp_body_id || undefined,
      reqHeaderId: row.req_header_id || undefined,
      respHeaderId: row.resp_header_id || undefined,
      originalReqHeaderId: row.original_req_header_id || undefined,
      originalReqBodyId: row.original_req_body_id || undefined,
      transformedPath: row.transformed_path || undefined,
      requestType: row.request_type as 'final' | 'retry' | 'recovery' | undefined,
      isFailoverAttempt: row.is_failover_attempt === 1,
      parentRequestId: row.parent_request_id || undefined,
      attemptNumber: row.attempt_number ?? undefined,
      attemptUpstream: row.attempt_upstream || undefined,
    };
  }
}

// 单例实例
export const logQueryService = new LogQueryService();
