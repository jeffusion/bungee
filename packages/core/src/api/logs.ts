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

  // Sorting
  sortBy?: 'timestamp' | 'duration' | 'status';
  sortOrder?: 'asc' | 'desc';
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
  processingSteps?: ProcessingStep[];
  authSuccess: boolean;
  authLevel?: string;
  errorMessage?: string;
  success: boolean;
  reqBodyId?: string;
  respBodyId?: string;
  reqHeaderId?: string;
  respHeaderId?: string;
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

  constructor() {
    this.db = accessLogWriter.getDatabase();
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
      'errorMessage', 'success'
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
      SELECT
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
        AVG(duration) as avg_response_time
      FROM access_logs
      ${whereClause}
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
      SELECT
        (timestamp / ${intervalSeconds * 1000}) * ${intervalSeconds * 1000} as bucket,
        COUNT(*) as total_requests,
        SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_requests,
        SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as failed_requests,
        AVG(duration) as avg_response_time
      FROM access_logs
      WHERE timestamp >= ? AND timestamp <= ?
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
    };
  }
}

// 单例实例
export const logQueryService = new LogQueryService();
