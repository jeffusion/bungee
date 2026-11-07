import type { AccessLogIdentity, ProcessingStep } from '../logger/access-log-writer';
import type { TransportType } from '../logger/transport-outcome';
import type { Database } from 'bun:sqlite';
import { TRANSPORT_OUTCOMES, emptyHttpCounts, emptyTransportCounts, emptyRequestCounts, type RequestCounts, type HttpStatusCounts, type TransportCounts, type TransportOutcome } from '../logger/transport-outcome';
import { ACCESS_LOG_CHAIN_ID_SQL } from '../migrations/access-log-record-identity';

type LogIdentityFilters = Pick<AccessLogIdentity, 'recordKind' | 'accessId' | 'operationId'>;

export interface LogQueryParams extends LogIdentityFilters {
  groupBy?: 'chain';
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
  transportOutcome?: TransportOutcome;
  transportType?: TransportType;
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

export interface LogEntry extends AccessLogIdentity {
  id: number;
  requestId: string;
  timestamp: number;
  method: string;
  transportType: TransportType | null;
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
  transportOutcome: TransportOutcome;
  transportCode?: string;
  protocolOutcome?: 'completed' | 'failed' | 'incomplete' | 'cancelled';
  protocolCode?: string;
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
  chainId: string;
  chainAttempts: number;
  chainDurationMs: number;                       // chainEndTs - chainStartTs
  chainStatus: number;                           // 访问或操作摘要的状态，其次按最终尝试选取
  chainTransportOutcome: TransportOutcome;
  chainTransportCode?: string;
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

export interface TimeSeriesStatsPoint {
  requestCounts?: RequestCounts;
  httpStatusCounts?: HttpStatusCounts;
  transportCounts?: TransportCounts;
  timestamp: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  avgResponseTime: number;
}

export interface UpstreamOutcomeStats {
  requestCounts: RequestCounts;
  httpStatusCounts: HttpStatusCounts;
  transportCounts: TransportCounts;
  upstream: string;
  count: number;
  percentage: number;
  totalRequests: number;
  successRequests: number;
  failedRequests: number;
  failureRate: number;
  successRate: number;
  status2xx: number;
  status3xx: number;
  status4xx: number;
  status5xx: number;
  statusOther: number;
  failed2xx: number;
}

// Classify the final result, including interrupted streams, independently of HTTP headers.
function outcomeSql(status: string, success: string, protocol: string): string {
  return `CASE
    WHEN ${protocol} IN ('failed', 'incomplete', 'cancelled') OR ${success} = 0 OR ${status} >= 400 THEN 'failed'
    ELSE 'success'
  END`;
}

function transportSql(column: string): string {
  return `CASE WHEN ${column} IN ('pending','completed','failed','cancelled') THEN ${column} ELSE 'unknown' END`;
}
function countSql(status: string, transport: string, acceptedDisconnect = '0', webSocketOperation?: string): string {
  const successStatus = `(${status} >= 200 AND ${status} < 300 OR ${acceptedDisconnect} = 1)`;
  const success = `${transport} = 'completed' AND ${successStatus}`;
  const failed = `${transport} = 'failed' OR (${transport} = 'completed' AND NOT COALESCE(${successStatus}, 0))`;
  const httpOnly = webSocketOperation ? `NOT ${webSocketOperation} AND ` : '';
  const requestOutcome = (name: string, httpOutcome: string) => webSocketOperation
    ? `CASE WHEN ${webSocketOperation} THEN chain_outcome = '${name}' ELSE ${httpOutcome} END` : httpOutcome;
  return [
    ...[2, 3, 4, 5].map(n => `SUM(${httpOnly}${status} >= ${n}00 AND ${status} < ${n + 1}00) AS status${n}xx`),
    `SUM(${httpOnly}(${status} < 200 OR ${status} >= 600 OR ${status} IS NULL)) AS statusOther`,
    `SUM(${requestOutcome('success', success)}) AS request_success`,
    `SUM(${requestOutcome('failed', failed)}) AS request_failed`,
    ...TRANSPORT_OUTCOMES.map(key => `SUM(${transportSql(transport)} = '${key}') AS transport_${key}`),
  ].join(', ');
}
function counts(row: Record<string, any>): { requestCounts: RequestCounts; httpStatusCounts: HttpStatusCounts; transportCounts: TransportCounts } {
  const httpStatusCounts = emptyHttpCounts();
  const transportCounts = emptyTransportCounts();
  for (const key of Object.keys(httpStatusCounts) as Array<keyof HttpStatusCounts>) httpStatusCounts[key] = row[key] ?? 0;
  for (const key of TRANSPORT_OUTCOMES) transportCounts[key] = row[`transport_${key}`] ?? 0;
  return { requestCounts: { success: row.request_success ?? 0, failed: row.request_failed ?? 0 }, httpStatusCounts, transportCounts };
}

export type StatsHistoryInterval = '10s' | '1m' | '5m';

/**
 * 日志查询服务
 *
 * 提供查询、过滤、排序、导出等功能
 */
export class LogQueryService {
  private db: Database;
  private readonly transportColumn: string;
  private readonly transportCodeColumn: string;
  private readonly hasTransportType: boolean;
  private readonly recordKindColumn: 'record_kind' | 'NULL';
  private readonly chainIdSql: string;

  // chain 模式 sortBy 白名单 → SQL alias 映射，禁止任何前端字符串直接拼 SQL ORDER BY
  private static readonly CHAIN_SORT_COLUMNS: Readonly<Record<'timestamp' | 'duration' | 'status', string>> = {
    timestamp: 'chain_start_ts',
    duration: 'chain_duration_ms',
    status: 'chain_status',
  };

  constructor(db: Database) {
    this.db = db;
    const columns = db.query('PRAGMA table_info(access_logs)').all() as Array<{ name: string }>;
    this.transportColumn = columns.some(c => c.name === 'transport_outcome') ? 'transport_outcome' : 'NULL';
    this.transportCodeColumn = columns.some(c => c.name === 'transport_code') ? 'transport_code' : 'NULL';
    this.hasTransportType = columns.some(c => c.name === 'transport_type');
    this.recordKindColumn = columns.some(c => c.name === 'record_kind') ? 'record_kind' : 'NULL';
    this.chainIdSql = this.recordKindColumn === 'NULL'
      ? 'COALESCE(parent_request_id, request_id)' : ACCESS_LOG_CHAIN_ID_SQL;
  }

  private get recordRankSql(): string {
    return `CASE ${this.recordKindColumn} WHEN 'access' THEN 0 WHEN 'operation' THEN 1 ELSE 2 END`;
  }

  private get statusOrderSql(): string {
    return `${this.recordRankSql},
      CASE WHEN request_type = 'final' THEN 0 ELSE 1 END,
      COALESCE(attempt_number, -1) DESC, timestamp DESC, id DESC`;
  }

  private get representativeOrderSql(): string {
    return `${this.recordRankSql},
      attempt_number ASC, timestamp ASC, id ASC`;
  }

  private clientRequestSql(alias = 'access_logs'): string {
    if (!this.hasTransportType) return '1';
    if (this.recordKindColumn === 'NULL') return `${alias}.transport_type IS NOT 'websocket'`;
    // Before record identities were added, only the hosted HTTP pipeline wrote WebSocket rows.
    return `NOT (${alias}.transport_type IS 'websocket' AND (${alias}.record_kind IS NULL OR ${alias}.record_kind = 'access'))
      AND NOT (${alias}.record_kind IS 'attempt' AND ${alias}.operation_id IS NOT NULL AND (
        ${alias}.transport_type IS 'websocket' OR EXISTS (
          SELECT 1 FROM access_logs op WHERE op.operation_id = ${alias}.operation_id
            AND op.record_kind = 'operation' AND op.transport_type = 'websocket'
        )
      ))`;
  }

  /** Ingress and worker logs can arrive in either order. Resolve against their shared access ID. */
  private acceptedDisconnectSql(alias = 'access_logs'): string {
    if (this.recordKindColumn === 'NULL' || this.transportCodeColumn === 'NULL') return '0';
    return `CASE WHEN ${alias}.record_kind = 'access' AND ${alias}.transport_type = 'http'
      AND ${alias}.status BETWEEN 200 AND 299 AND ${alias}.transport_outcome = 'cancelled'
      AND ${alias}.transport_code = 'client_cancelled' THEN COALESCE((
      SELECT op.transport_code = 'terminal_before_client_disconnect'
      FROM access_logs op WHERE op.access_id = ${alias}.access_id AND op.record_kind = 'operation'
      ORDER BY op.timestamp DESC, op.id DESC LIMIT 1
    ), 0) AND NOT EXISTS (
      SELECT 1 FROM access_logs op WHERE op.access_id = ${alias}.access_id AND op.record_kind = 'operation'
        AND op.observation_outcome IS NOT 'complete'
    ) ELSE 0 END`;
  }

  private effectiveTransportSql(alias = 'access_logs'): string {
    return `CASE WHEN ${this.acceptedDisconnectSql(alias)} THEN 'completed' ELSE ${this.transportColumn} END`;
  }

  private get webSocketOperationSql(): string {
    return this.recordKindColumn === 'NULL' || !this.hasTransportType
      ? '0' : "record_kind IS 'operation' AND transport_type IS 'websocket'";
  }

  private get requestStatusSql(): string {
    return `CASE WHEN ${this.webSocketOperationSql} AND status = 0 THEN 101 ELSE status END`;
  }

  private get requestMethodSql(): string {
    return `CASE WHEN ${this.webSocketOperationSql} AND status = 0 THEN 'GET' ELSE method END`;
  }

  private get chainStatsCtes(): string {
    const webSocketOperation = this.webSocketOperationSql;
    const observationOutcome = this.recordKindColumn === 'NULL' ? 'NULL' : 'observation_outcome';
    return `
    chain_rows AS (
      SELECT
        ${this.chainIdSql} AS chain_id,
        id,
        timestamp,
        duration,
        status,
        success,
        protocol_outcome,
        ${observationOutcome} AS observation_outcome,
        (${webSocketOperation}) AS websocket_operation,
        ${this.effectiveTransportSql()} AS transport_outcome,
        ${this.acceptedDisconnectSql()} AS accepted_disconnect,
        request_type,
        attempt_number,
        ROW_NUMBER() OVER (
          PARTITION BY ${this.chainIdSql}
          ORDER BY ${this.statusOrderSql}
        ) AS status_rank
      FROM access_logs
      WHERE (${this.recordKindColumn} IS NULL OR ${this.recordKindColumn} = 'access' OR (${webSocketOperation})
        OR (${this.recordKindColumn} = 'attempt' AND ${this.recordKindColumn === 'NULL' ? 'NULL' : 'transport_type'} = 'http'))
        AND ${this.clientRequestSql()}
    ),
    chains AS (
      SELECT
        chain_id,
        MIN(timestamp) AS chain_start_ts,
        MAX(timestamp + duration) AS chain_end_ts,
        MAX(CASE WHEN status_rank = 1 THEN status END) AS chain_status,
        MAX(CASE WHEN status_rank = 1 THEN CASE WHEN accepted_disconnect THEN 1 ELSE success END END) AS final_success,
        MAX(CASE WHEN status_rank = 1 THEN protocol_outcome END) AS final_protocol_outcome,
        MAX(CASE WHEN status_rank = 1 THEN transport_outcome END) AS final_transport_outcome,
        MAX(CASE WHEN status_rank = 1 THEN observation_outcome END) AS final_observation_outcome,
        MAX(CASE WHEN status_rank = 1 THEN websocket_operation END) AS websocket_operation,
        MAX(CASE WHEN status_rank = 1 THEN accepted_disconnect END) AS accepted_disconnect,
        MAX(timestamp + duration) - MIN(timestamp) AS chain_duration_ms
      FROM chain_rows
      GROUP BY chain_id
    ),
    classified_chains AS (
      SELECT *,
        CASE WHEN websocket_operation THEN CASE
          WHEN final_transport_outcome = 'completed' AND final_protocol_outcome = 'completed' AND final_success = 1 THEN 'success'
          WHEN final_observation_outcome IS NOT NULL OR final_protocol_outcome IS NOT NULL
            OR final_transport_outcome IN ('completed', 'failed', 'cancelled') THEN 'failed'
        END ELSE ${outcomeSql('chain_status', 'final_success', 'final_protocol_outcome')} END AS chain_outcome
      FROM chains
    )`;
  }

  private addIdentityFilters(params: LogIdentityFilters, clauses: string[], bindings: unknown[]): void {
    for (const [column, value] of [
      ['record_kind', params.recordKind], ['access_id', params.accessId], ['operation_id', params.operationId],
    ] as const) {
      if (value === undefined) continue;
      clauses.push(this.recordKindColumn === 'NULL' ? 'NULL = ?' : `${column} = ?`);
      bindings.push(value);
    }
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
      transportOutcome,
      transportType,
      searchTerm,
      requestType,
      sortBy = 'timestamp',
      sortOrder = 'desc',
    } = params;

    // Build WHERE clause
    const whereClauses = params.recordKind === undefined ? [this.clientRequestSql()] : [];
    const whereParams: any[] = [];
    this.addIdentityFilters(params, whereClauses, whereParams);

    if (startTime !== undefined) {
      whereClauses.push('timestamp >= ?');
      whereParams.push(startTime);
    }
    if (endTime !== undefined) {
      whereClauses.push('timestamp < ?');
      whereParams.push(endTime);
    }
    if (transportType !== undefined) {
      if (transportType !== 'http' && transportType !== 'websocket') throw new Error('Invalid transport type');
      whereClauses.push('transport_type = ?');
      whereParams.push(transportType);
    }
    if (method) {
      whereClauses.push(`${this.requestMethodSql} = ?`);
      whereParams.push(method);
    }
    if (path) {
      whereClauses.push('path LIKE ?');
      whereParams.push(`%${path}%`);
    }
    if (status !== undefined) {
      if (Array.isArray(status)) {
        whereClauses.push(`${this.requestStatusSql} IN (${status.map(() => '?').join(', ')})`);
        whereParams.push(...status);
      } else {
        whereClauses.push(`${this.requestStatusSql} = ?`);
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
      whereClauses.push(`CASE WHEN ${this.acceptedDisconnectSql()} THEN 1 ELSE success END = ?`);
      whereParams.push(success ? 1 : 0);
    }
    if (transportOutcome !== undefined) {
      if (!TRANSPORT_OUTCOMES.includes(transportOutcome)) throw new Error('Invalid transport outcome');
      whereClauses.push(`${transportSql(this.effectiveTransportSql())} = ?`);
      whereParams.push(transportOutcome);
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
    const countResult = this.db.query(countQuery).get(...whereParams) as { total: number };
    const total = countResult.total;

    // Get paginated data
    const offset = (page - 1) * limit;
    const sortColumn = sortBy === 'timestamp' ? 'timestamp' : sortBy === 'duration' ? 'duration' : this.requestStatusSql;
    const order = sortOrder.toUpperCase();

    const dataQuery = `
      SELECT *, ${this.acceptedDisconnectSql()} AS accepted_disconnect FROM access_logs
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.query(dataQuery).all(...whereParams, limit, offset) as any[];

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
    const query = `SELECT *, ${this.acceptedDisconnectSql()} AS accepted_disconnect FROM access_logs WHERE request_id = ?`;
    const row = this.db.query(query).get(requestId) as any;

    if (!row) {
      return null;
    }

    return this.mapRowToLogEntry(row);
  }

  getLatestLogId(): number {
    const row = this.db.query<{ id: number | null }, []>('SELECT MAX(id) AS id FROM access_logs').get();
    return row?.id ?? 0;
  }

  /** WebSocket observation can start well before its row is persisted. */
  async querySince(id: number): Promise<LogEntry[]> {
    const rows = this.db.query(`
      SELECT * FROM access_logs
      WHERE id > ? AND ${this.clientRequestSql()}
      ORDER BY id ASC
      LIMIT 256
    `).all(id) as any[];
    return rows.map(row => this.mapRowToLogEntry(row));
  }

  /**
   * HTTP 访问与其尝试组成一条链，WebSocket 操作独立于连接聚合。
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
      transportOutcome,
      transportType,
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
    const rowWhereClauses = params.recordKind === undefined ? [this.clientRequestSql()] : [];
    const rowWhereParams: any[] = [];
    this.addIdentityFilters(params, rowWhereClauses, rowWhereParams);

    if (transportType !== undefined) {
      if (transportType !== 'http' && transportType !== 'websocket') throw new Error('Invalid transport type');
      rowWhereClauses.push('transport_type = ?');
      rowWhereParams.push(transportType);
    }
    if (method) {
      rowWhereClauses.push(`${this.requestMethodSql} = ?`);
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
    if (startTime !== undefined) { chainWhereClauses.push('chain_start_ts >= ?'); chainWhereParams.push(startTime); }
    if (endTime !== undefined) { chainWhereClauses.push('chain_start_ts < ?'); chainWhereParams.push(endTime); }

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
      chainWhereClauses.push('chain_success = ?');
      chainWhereParams.push(success ? 1 : 0);
    }
    if (transportOutcome !== undefined) {
      if (!TRANSPORT_OUTCOMES.includes(transportOutcome)) throw new Error('Invalid transport outcome');
      chainWhereClauses.push(`${transportSql('final_transport_outcome')} = ?`);
      chainWhereParams.push(transportOutcome);
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

    const chainCtes = `
      WITH filtered_chain_ids AS (
        SELECT DISTINCT ${this.chainIdSql} AS chain_id
        FROM access_logs
        ${rowWhereClause}
      ),
      chain_rows AS (
        SELECT
          al.*,
          ${this.requestStatusSql} AS observed_http_status,
          ${this.recordKindColumn} AS observed_record_kind,
          ${this.effectiveTransportSql('al')} AS observed_transport_outcome,
          ${this.acceptedDisconnectSql('al')} AS accepted_disconnect,
          ${this.transportCodeColumn} AS observed_transport_code,
          ${this.chainIdSql} AS chain_id,
          al.timestamp + al.duration AS end_ts,
          ROW_NUMBER() OVER (
            PARTITION BY ${this.chainIdSql}
            ORDER BY ${this.representativeOrderSql}
          ) AS rep_rank,
          ROW_NUMBER() OVER (
            PARTITION BY ${this.chainIdSql}
            ORDER BY ${this.statusOrderSql}
          ) AS status_rank
        FROM access_logs al
        JOIN filtered_chain_ids f ON f.chain_id = ${this.chainIdSql}
        ${params.recordKind === undefined ? `WHERE ${this.clientRequestSql('al')}` : ''}
      ),
      agg AS (
        SELECT
          chain_id,
          MIN(timestamp) AS chain_start_ts,
          MAX(end_ts) AS chain_end_ts,
          COUNT(CASE WHEN observed_record_kind IS NULL OR observed_record_kind = 'attempt' THEN 1 END) AS chain_attempts,
          MAX(CASE WHEN is_failover_attempt = 1 THEN 1 ELSE 0 END) AS has_retry,
          MAX(CASE WHEN status_rank = 1 THEN observed_http_status END) AS chain_status,
          MAX(CASE WHEN status_rank = 1 THEN CASE WHEN accepted_disconnect THEN 1 WHEN observed_record_kind IS NULL THEN status < 400 ELSE success END END) AS chain_success,
          MAX(CASE WHEN status_rank = 1 THEN observed_transport_outcome END) AS final_transport_outcome,
          MAX(CASE WHEN status_rank = 1 THEN observed_transport_code END) AS final_transport_code,
          (MAX(end_ts) - MIN(timestamp)) AS chain_duration_ms
        FROM chain_rows
        GROUP BY chain_id
      )
    `;
    const countParams = [...rowWhereParams, ...chainWhereParams];
    const countResult = this.db.query(`${chainCtes} SELECT COUNT(*) AS total FROM agg ${chainWhereClause}`)
      .get(...countParams) as { total: number };
    const total = countResult.total;

    const offset = Math.max(0, (page - 1) * limit);
    const protocolSummary = this.recordKindColumn === 'record_kind' ? {
      columns: `app.protocol AS app_protocol, app.operation AS app_operation, app.operation_id AS app_operation_id,
        app.protocol_outcome AS app_outcome, app.protocol_code AS app_code, app.observation_outcome AS app_observation,`,
      join: `LEFT JOIN chain_rows app ON app.id = (
        SELECT id FROM chain_rows WHERE chain_id = agg.chain_id AND observed_record_kind = 'operation' ORDER BY id LIMIT 1
      )`,
    } : { columns: '', join: '' };
    const dataQuery = `
      ${chainCtes}
      SELECT
        rep.*,
        ${protocolSummary.columns}
        agg.chain_start_ts,
        agg.chain_end_ts,
        agg.chain_attempts,
        agg.has_retry,
        agg.chain_status,
        agg.final_transport_outcome,
        agg.final_transport_code,
        agg.chain_duration_ms,
        CASE WHEN rep.observed_record_kind IN ('access', 'operation') AND rep.route_path IS NULL THEN (
          SELECT route_path FROM chain_rows
          WHERE chain_id = agg.chain_id AND route_path IS NOT NULL
          ORDER BY rep_rank LIMIT 1
        ) END AS inherited_route_path,
        CASE WHEN rep.observed_record_kind IN ('access', 'operation') AND rep.upstream IS NULL THEN (
          SELECT upstream FROM chain_rows
          WHERE chain_id = agg.chain_id AND upstream IS NOT NULL
          ORDER BY status_rank LIMIT 1
        ) END AS inherited_upstream
      FROM agg
      JOIN chain_rows rep ON rep.chain_id = agg.chain_id AND rep.rep_rank = 1
      ${protocolSummary.join}
      ${chainWhereClause}
      ORDER BY ${sortColumn} ${sortDirection}
      LIMIT ? OFFSET ?
    `;
    const dataParams = [...rowWhereParams, ...chainWhereParams, limit, offset];
    const rows = this.db.query(dataQuery).all(...dataParams) as any[];

    const data: ChainEntry[] = rows.map(row => ({
      ...this.mapRowToLogEntry(row),
      routePath: row.route_path ?? row.inherited_route_path ?? undefined,
      upstream: row.upstream ?? row.inherited_upstream ?? undefined,
      ...(row.app_operation_id ? {
        operationId: row.app_operation_id, protocol: row.app_protocol, operation: row.app_operation,
        protocolOutcome: row.app_outcome ?? undefined, protocolCode: row.app_code ?? undefined,
        observationOutcome: row.app_observation ?? undefined,
      } : {}),
      chainId: row.chain_id,
      chainAttempts: row.chain_attempts,
      chainDurationMs: row.chain_duration_ms,
      chainStatus: row.chain_status,
      chainTransportOutcome: TRANSPORT_OUTCOMES.includes(row.final_transport_outcome) ? row.final_transport_outcome : 'unknown',
      chainTransportCode: row.final_transport_code ?? undefined,
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
      WHERE ${this.chainIdSql} = ?
        AND (${this.recordKindColumn} IS NULL OR ${this.recordKindColumn} = 'attempt')
        AND ${this.clientRequestSql()}
      GROUP BY target
      HAVING target IS NOT NULL
      ORDER BY first_attempt, first_ts
    `;
    const rows = this.db.query(query).all(chainId) as any[];
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
      SELECT *, ${this.acceptedDisconnectSql()} AS accepted_disconnect,
        ROW_NUMBER() OVER (ORDER BY ${this.statusOrderSql}) AS status_rank
      FROM access_logs
      WHERE ${this.chainIdSql} = ? AND ${this.clientRequestSql()}
      ORDER BY ${this.representativeOrderSql}
    `;
    const rows = this.db.query(query).all(chainId) as any[];

    if (rows.length === 0) {
      return null;
    }

    const records = rows.map(row => this.mapRowToLogEntry(row));
    const attempts = records.filter(row => row.recordKind === undefined || row.recordKind === 'attempt');
    const chainStartTs = Math.min(...records.map(a => a.timestamp));
    const chainEndTs = Math.max(...records.map(a => a.timestamp + a.duration));
    const chainAttempts = attempts.length;
    const hasRetry = attempts.some(a => a.isFailoverAttempt);
    const finalRow = records[rows.findIndex(row => row.status_rank === 1)]!;
    const repRow = records[0]!;
    const routePath = repRow.recordKind === 'access' || repRow.recordKind === 'operation'
      ? repRow.routePath ?? records.find(a => a.routePath !== undefined)?.routePath
      : repRow.routePath;
    const upstreamsData = await this.getChainUpstreams(chainId);
    const operation = records.find(row => row.recordKind === 'operation');
    const finalAttempt = attempts.findLast(row => row.requestType === 'final') ?? attempts.at(-1);

    const chain: ChainEntry = {
      ...repRow,
      status: finalRow.status,
      duration: chainEndTs - chainStartTs,
      transportOutcome: finalRow.transportOutcome,
      transportCode: finalRow.transportCode,
      success: finalRow.success,
      routePath,
      upstream: repRow.upstream ?? upstreamsData[0]?.target,
      transformer: repRow.transformer ?? finalAttempt?.transformer,
      transformedPath: repRow.transformedPath ?? finalAttempt?.transformedPath,
      processingSteps: repRow.processingSteps ?? operation?.processingSteps ?? finalAttempt?.processingSteps,
      errorMessage: repRow.errorMessage ?? operation?.errorMessage ?? finalAttempt?.errorMessage,
      originalReqBodyId: repRow.originalReqBodyId ?? operation?.originalReqBodyId ?? finalAttempt?.originalReqBodyId,
      originalReqHeaderId: repRow.originalReqHeaderId ?? operation?.originalReqHeaderId ?? finalAttempt?.originalReqHeaderId,
      reqBodyId: repRow.reqBodyId ?? finalAttempt?.reqBodyId,
      reqHeaderId: repRow.reqHeaderId ?? finalAttempt?.reqHeaderId,
      respBodyId: repRow.respBodyId ?? operation?.respBodyId ?? finalAttempt?.respBodyId,
      respHeaderId: repRow.respHeaderId ?? operation?.respHeaderId ?? finalAttempt?.respHeaderId,
      authLevel: repRow.authLevel ?? finalAttempt?.authLevel,
      authSuccess: repRow.authLevel ? repRow.authSuccess : finalAttempt?.authSuccess ?? repRow.authSuccess,
      ...(operation ? {
        operationId: operation.operationId, protocol: operation.protocol, operation: operation.operation,
        protocolOutcome: operation.protocolOutcome, protocolCode: operation.protocolCode, observationOutcome: operation.observationOutcome,
      } : {}),
      chainId,
      chainAttempts,
      chainDurationMs: chainEndTs - chainStartTs,
      chainStatus: finalRow.status,
      chainTransportOutcome: finalRow.transportOutcome,
      chainTransportCode: finalRow.transportCode,
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
    let lastId = this.getLatestLogId();

    while (true) {
      for (const entry of await this.querySince(lastId)) {
        lastId = entry.id;
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
    const result = params.groupBy === 'chain'
      ? await this.queryChains({ ...params, limit: 999999, page: 1 })
      : await this.query({ ...params, limit: 999999, page: 1 });

    if (format === 'json') {
      return JSON.stringify(result.data, null, 2);
    }

    // CSV format
    if (result.data.length === 0) {
      return '';
    }

    const headers = [
      'requestId', 'timestamp', 'transportType', 'method', 'path', 'query', 'status', 'duration',
      'routePath', 'upstream', 'transformer', 'authSuccess', 'authLevel',
      'errorMessage', 'success', 'requestType', 'transportOutcome', 'transportCode', 'protocolOutcome', 'protocolCode',
      'recordKind', 'accessId', 'operationId', 'protocol', 'operation', 'closeCode', 'observationOutcome',
      ...(params.groupBy === 'chain' ? ['chainId', 'chainStatus', 'chainDurationMs', 'chainTransportOutcome', 'chainTransportCode'] : [])
    ];

    const csvRows = [
      headers.join(','),
      ...result.data.map(entry => {
        const chain = params.groupBy === 'chain' ? entry as ChainEntry : undefined;
        return [
          entry.requestId,
          new Date(entry.timestamp).toISOString(),
          entry.transportType ?? '',
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
          entry.transportOutcome,
          entry.transportCode || '',
          entry.protocolOutcome || '',
          entry.protocolCode || '',
          entry.recordKind ?? '',
          ...[entry.accessId, entry.operationId, entry.protocol, entry.operation].map(value =>
            value === undefined ? '' : /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value),
          entry.closeCode ?? '',
          entry.observationOutcome ?? '',
          ...(chain ? [chain.chainId, chain.chainStatus, chain.chainDurationMs, chain.chainTransportOutcome, chain.chainTransportCode || ''] : []),
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
    requestCounts?: RequestCounts;
  httpStatusCounts?: HttpStatusCounts;
    transportCounts?: TransportCounts;
  }> {
    if (
      (startTime !== undefined && !Number.isInteger(startTime))
      || (endTime !== undefined && !Number.isInteger(endTime))
      || (startTime !== undefined && endTime !== undefined && startTime > endTime)
    ) {
      throw new Error('Invalid stats time range');
    }

    const query = `
      WITH ${this.chainStatsCtes}
      SELECT
        COUNT(*) AS total_requests,
        SUM(CASE WHEN chain_outcome = 'success' THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN chain_outcome = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
        AVG(chain_duration_ms) AS avg_response_time,
        ${countSql('chain_status', 'final_transport_outcome', 'accepted_disconnect', 'websocket_operation')}
      FROM classified_chains
      ${startTime !== undefined || endTime !== undefined ? `WHERE ${[
        startTime !== undefined ? 'chain_start_ts >= ?' : '',
        endTime !== undefined ? 'chain_start_ts < ?' : '',
      ].filter(Boolean).join(' AND ')}` : ''}
    `;

    const params = [
      ...(startTime !== undefined ? [startTime] : []),
      ...(endTime !== undefined ? [endTime] : []),
    ];
    const result = this.db.query(query).get(...params) as any;

    return {
      totalRequests: result.total_requests || 0,
      successRequests: result.success_requests || 0,
      failedRequests: result.failed_requests || 0,
      avgResponseTime: result.avg_response_time || 0,
      ...counts(result),
    };
  }

  /**
   * 统计半开区间内的 chain 数，用于避免把当前未完成的秒再次计入 QPS。
   */
  async getChainCount(startTime: number, endTimeExclusive: number): Promise<number> {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTimeExclusive) || startTime >= endTimeExclusive) {
      throw new Error('Invalid stats time range');
    }

    const query = `
      WITH ${this.chainStatsCtes}
      SELECT COUNT(*) AS total_requests
      FROM classified_chains
      WHERE chain_start_ts >= ? AND chain_start_ts < ?
    `;

    const row = this.db.query(query).get(startTime, endTimeExclusive) as { total_requests: number };
    return row.total_requests || 0;
  }

  /**
   * 返回最近一小时的累计统计点。点和聚合均由 access_logs SQL 生成，按 chain 起始时间归桶。
   */
  async getCumulativeHistory(
    startTime: number,
    endTimeExclusive: number,
    interval: StatsHistoryInterval,
  ): Promise<Array<{ timestamp: number; requests: number; errors: number; responseTime: number }>> {
    if (interval !== '10s' && interval !== '1m' && interval !== '5m') {
      throw new Error('Invalid stats interval');
    }
    const intervalMs = interval === '10s' ? 10_000 : interval === '1m' ? 60_000 : 300_000;
    if (
      !Number.isInteger(startTime)
      || !Number.isInteger(endTimeExclusive)
      || startTime >= endTimeExclusive
      || (endTimeExclusive - startTime) !== 60 * 60 * 1000
      || endTimeExclusive % intervalMs !== 0
      || startTime % intervalMs !== 0
    ) {
      throw new Error('Invalid stats history range');
    }

    const query = `
      WITH RECURSIVE ${this.chainStatsCtes},
      points(point_ts) AS (
        SELECT ? + ?
        UNION ALL
        SELECT point_ts + ?
        FROM points
        WHERE point_ts + ? <= ?
      )
      SELECT
        p.point_ts AS timestamp,
        COUNT(c.chain_id) AS requests,
        COALESCE(SUM(CASE WHEN c.chain_outcome = 'failed' THEN 1 ELSE 0 END), 0) AS errors,
        COALESCE(AVG(c.chain_duration_ms), 0) AS response_time
      FROM points p
      LEFT JOIN classified_chains c
        ON c.chain_start_ts >= ?
        AND c.chain_start_ts < p.point_ts
        AND c.chain_start_ts < ?
      GROUP BY p.point_ts
      ORDER BY p.point_ts ASC
    `;

    const rows = this.db.query(query).all(
      startTime,
      intervalMs,
      intervalMs,
      intervalMs,
      endTimeExclusive,
      startTime,
      endTimeExclusive,
    ) as Array<{ timestamp: number; requests: number; errors: number; response_time: number }>;

    return rows.map(row => ({
      timestamp: row.timestamp,
      requests: row.requests || 0,
      errors: row.errors || 0,
      responseTime: row.response_time || 0,
    }));
  }

  /**
   * 获取时间序列统计数据（用于图表）
   */
  async getTimeSeriesStats(
    startTime: number,
    endTime: number,
    interval: 'minute' | '30min' | 'hour' | 'day' = 'minute',
  ): Promise<TimeSeriesStatsPoint[]> {
    return this.queryTimeSeriesStats(startTime, endTime, interval);
  }

  private queryTimeSeriesStats(
    startTime: number,
    endTime: number,
    interval: 'minute' | '30min' | 'hour' | 'day',
  ): TimeSeriesStatsPoint[] {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime > endTime) {
      throw new Error('Invalid stats time range');
    }

    if (interval !== 'minute' && interval !== '30min' && interval !== 'hour' && interval !== 'day') {
      throw new Error('Invalid stats interval');
    }

    // Calculate interval in seconds
    const intervalSeconds =
      interval === 'minute' ? 60 :
      interval === '30min' ? 1800 :
      interval === 'hour' ? 3600 :
      86400;

    const query = `
      WITH ${this.chainStatsCtes}
      SELECT
        (chain_start_ts / ${intervalSeconds * 1000}) * ${intervalSeconds * 1000} AS bucket,
        COUNT(*) AS total_requests,
        SUM(CASE WHEN chain_outcome = 'success' THEN 1 ELSE 0 END) AS success_requests,
        SUM(CASE WHEN chain_outcome = 'failed' THEN 1 ELSE 0 END) AS failed_requests,
        AVG(chain_duration_ms) AS avg_response_time,
        ${countSql('chain_status', 'final_transport_outcome', 'accepted_disconnect', 'websocket_operation')}
      FROM classified_chains
      WHERE chain_start_ts >= ? AND chain_start_ts < ?
      GROUP BY bucket
      ORDER BY bucket ASC
    `;

    const rows = this.db.query(query).all(startTime, endTime) as any[];

    const dataPoints = rows.map(row => ({
      timestamp: row.bucket,
      totalRequests: row.total_requests,
      successRequests: row.success_requests,
      failedRequests: row.failed_requests,
      avgResponseTime: row.avg_response_time,
      ...counts(row),
    }));

    // Fill missing time points with zero values
    return this.fillMissingTimePoints(dataPoints, startTime, endTime, intervalSeconds * 1000);
  }

  /** Both queries execute synchronously inside one SQLite read snapshot. */
  async getDashboardStats(
    startTime: number,
    endTime: number,
    interval: 'minute' | '30min' | 'hour' | 'day',
  ): Promise<{ timeSeries: TimeSeriesStatsPoint[]; upstreams: UpstreamOutcomeStats[]; requestCounts?: RequestCounts; httpStatusCounts?: HttpStatusCounts; transportCounts?: TransportCounts }> {
    return this.db.transaction(() => {
      const timeSeries = this.queryTimeSeriesStats(startTime, endTime, interval);
      const requestCounts = emptyRequestCounts();
      const httpStatusCounts = emptyHttpCounts();
      const transportCounts = emptyTransportCounts();
      for (const point of timeSeries) {
        requestCounts.success += point.requestCounts?.success ?? 0;
        requestCounts.failed += point.requestCounts?.failed ?? 0;
        for (const key of Object.keys(httpStatusCounts) as Array<keyof HttpStatusCounts>) httpStatusCounts[key] += point.httpStatusCounts?.[key] ?? 0;
        for (const key of TRANSPORT_OUTCOMES) transportCounts[key] += point.transportCounts?.[key] ?? 0;
      }
      return { timeSeries, upstreams: this.queryUpstreamStats(startTime, endTime), requestCounts, httpStatusCounts, transportCounts };
    })();
  }

  private queryUpstreamStats(startTime: number, endTime: number): UpstreamOutcomeStats[] {
    if (!Number.isInteger(startTime) || !Number.isInteger(endTime) || startTime > endTime) {
      throw new Error('Invalid stats time range');
    }
    const rows = this.db.query(`
      WITH outcome_rows AS (
        SELECT upstream, status, ${this.transportColumn} AS observed_transport_outcome, ${outcomeSql('status', 'success', 'protocol_outcome')} AS outcome
        FROM access_logs
        WHERE timestamp >= ? AND timestamp < ? AND upstream IS NOT NULL
          AND (${this.recordKindColumn} IS NULL OR ${this.recordKindColumn} = 'attempt')
          AND ${this.clientRequestSql()}
      )
      SELECT upstream, COUNT(*) AS total_requests,
        SUM(outcome = 'success') AS success_requests,
        SUM(outcome = 'failed') AS failed_requests,
        SUM(status >= 200 AND status < 300) AS status_2xx,
        SUM(status >= 300 AND status < 400) AS status_3xx,
        SUM(status >= 400 AND status < 500) AS status_4xx,
        SUM(status >= 500 AND status < 600) AS status_5xx,
        SUM(status < 200 OR status >= 600) AS status_other,
        SUM(status >= 200 AND status < 300 AND outcome = 'failed') AS failed_2xx,
        ${countSql('status', 'observed_transport_outcome')}
      FROM outcome_rows GROUP BY upstream ORDER BY total_requests DESC, upstream ASC
    `).all(startTime, endTime) as Array<Record<string, number> & { upstream: string }>;
    const total = rows.reduce((sum, row) => sum + row.total_requests, 0);
    const rate = (count: number, denominator: number) => denominator ? Math.round(count / denominator * 10_000) / 100 : 0;
    return rows.map(row => ({
      upstream: row.upstream, count: row.total_requests, totalRequests: row.total_requests,
      ...counts(row),
      percentage: rate(row.total_requests, total),
      successRequests: row.success_requests, failedRequests: row.failed_requests,
      successRate: rate(row.success_requests, row.total_requests),
      failureRate: rate(row.failed_requests, row.total_requests),
      status2xx: row.status_2xx, status3xx: row.status_3xx, status4xx: row.status_4xx, status5xx: row.status_5xx,
      statusOther: row.status_other, failed2xx: row.failed_2xx,
    }));
  }

  async getUpstreamDistribution(startTime: number, endTime: number, limit = 10) {
    return this.queryUpstreamStats(startTime, endTime).slice(0, limit)
      .map(({ upstream, count, percentage }) => ({ upstream, count, percentage }));
  }

  async getUpstreamFailureStats(startTime: number, endTime: number, limit = 10): Promise<UpstreamOutcomeStats[]> {
    return this.queryUpstreamStats(startTime, endTime)
      .sort((a, b) => b.failureRate - a.failureRate || b.totalRequests - a.totalRequests).slice(0, limit);
  }

  async getUnifiedUpstreamStats(
    startTime: number,
    endTime: number,
    type: 'all' | 'success' | 'failure' = 'all',
    limit = 10,
  ): Promise<UpstreamOutcomeStats[]> {
    const rows = this.queryUpstreamStats(startTime, endTime);
    const count = (row: UpstreamOutcomeStats) => type === 'success' ? row.successRequests : type === 'failure' ? row.failedRequests : row.totalRequests;
    const total = rows.reduce((sum, row) => sum + count(row), 0);
    // Filtering selects the distribution sample, never the per-upstream outcome totals.
    return rows.filter(row => count(row) > 0).sort((a, b) => count(b) - count(a)).slice(0, limit)
      .map(row => ({ ...row, count: count(row), percentage: total ? Math.round(count(row) / total * 10_000) / 100 : 0 }));
  }

  async getUpstreamStatusCodeStats(startTime: number, endTime: number, limit = 10): Promise<UpstreamOutcomeStats[]> {
    return this.queryUpstreamStats(startTime, endTime).slice(0, limit);
  }

  /**
   * 填充缺失的时间点，确保图表数据连续
   */
  private fillMissingTimePoints(
    dataPoints: TimeSeriesStatsPoint[],
    startTime: number,
    endTime: number,
    intervalMs: number,
  ): TimeSeriesStatsPoint[] {
    // Create a map of existing data points
    const dataMap = new Map<number, typeof dataPoints[0]>();
    for (const point of dataPoints) {
      dataMap.set(point.timestamp, point);
    }

    // Generate complete time series
    const result: typeof dataPoints = [];

    const alignedStart = Math.floor(startTime / intervalMs) * intervalMs;
    for (let timestamp = alignedStart; timestamp < endTime; timestamp += intervalMs) {
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
          requestCounts: emptyRequestCounts(),
          httpStatusCounts: emptyHttpCounts(),
          transportCounts: emptyTransportCounts(),
        });
      }
    }

    return result;
  }

  /**
   * 将数据库行映射为 LogEntry 对象
   */
  private mapRowToLogEntry(row: any): LogEntry {
    const missingUpgrade = row.record_kind === 'operation' && row.transport_type === 'websocket' && row.status === 0;
    return {
      id: row.id,
      requestId: row.request_id,
      recordKind: row.record_kind ?? undefined,
      accessId: row.access_id ?? undefined,
      operationId: row.operation_id ?? undefined,
      protocol: row.protocol ?? undefined,
      operation: row.operation ?? undefined,
      closeCode: row.close_code ?? undefined,
      observationOutcome: row.observation_outcome ?? undefined,
      timestamp: row.timestamp,
      method: missingUpgrade ? 'GET' : row.method,
      transportType: row.transport_type,
      path: row.path,
      query: row.query || undefined,
      status: missingUpgrade ? 101 : row.status,
      duration: row.duration,
      routePath: row.route_path || undefined,
      upstream: row.upstream || undefined,
      transformer: row.transformer || undefined,
      processingSteps: row.processing_steps ? JSON.parse(row.processing_steps) : undefined,
      authSuccess: row.auth_success === 1,
      authLevel: row.auth_level || undefined,
      errorMessage: row.error_message || undefined,
      success: row.accepted_disconnect === 1 || row.success === 1,
      transportOutcome: row.accepted_disconnect === 1 ? 'completed' : TRANSPORT_OUTCOMES.includes(row.transport_outcome) ? row.transport_outcome : 'unknown',
      transportCode: row.transport_code ?? undefined,
      protocolOutcome: row.protocol_outcome ?? undefined,
      protocolCode: row.protocol_code ?? undefined,
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
