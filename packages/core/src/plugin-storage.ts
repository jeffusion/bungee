import { Database } from 'bun:sqlite';
import type {
  PluginStorage, TokenStatsAttempt, TokenStatsGroupBy, TokenStatsMeteringStorage,
  TokenStatsMetricName, TokenStatsSnapshotMetrics, TokenStatsValueSource, TokenStatsRange,
} from './plugin.types';
import { logger } from './logger';
import { LRUCache, type LRUCacheOptions } from './plugin-storage-cache';
import { TOKEN_STATS_RETENTION_MS, TOKEN_STATS_RANGES, tokenStatsWindow } from './token-stats-window';

/**
 * 基于 SQLite 的插件存储实现
 * 每个插件实例拥有独立的存储空间（通过 pluginName 隔离）
 *
 * 特性：
 * - LRU缓存层（减少数据库访问）
 * - Write-Behind写入策略（批量写入优化）
 * - TTL过期检查
 */
export class SQLitePluginStorage implements PluginStorage {
  private db: Database;
  private pluginName: string;
  private cache: LRUCache | null = null;
  readonly metering?: TokenStatsMeteringStorage;

  constructor(
    db: Database,
    pluginName: string,
    cacheOptions?: LRUCacheOptions
  ) {
    this.db = db;
    this.pluginName = pluginName;
    if (pluginName === 'token-stats') this.metering = new SQLiteTokenStatsMetering(db);

    // 如果提供了缓存选项，初始化缓存
    if (cacheOptions) {
      this.cache = new LRUCache(
        cacheOptions,
        this.writeBackToDb.bind(this)
      );
      logger.debug(
        { pluginName, cacheOptions },
        'Plugin storage cache enabled'
      );
    }
  }

  /**
   * 写回回调函数，由LRUCache调用
   */
  private async writeBackToDb(
    key: string,
    value: any,
    ttl?: number
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const serializedValue = JSON.stringify(value);

    // Database-owned queries are finalized on close; uncached prepare() statements
    // otherwise retain the connection (and Windows file locks) until garbage collection.
    const stmt = this.db.query(`
      INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(this.pluginName, key, serializedValue, ttl ?? null, now * 1000);
  }

  /**
   * 获取值
   */
  async get<T = any>(key: string): Promise<T | null> {
    try {
      // 如果有缓存，先从缓存读取
      if (this.cache) {
        const cached = this.cache.get(key);
        if (cached !== null) {
          return cached as T;
        }
      }

      // 缓存未命中，从数据库读取
      const now = Math.floor(Date.now() / 1000);

      const query = this.db.query(`
        SELECT value, ttl FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      const result = query.get(this.pluginName, key) as { value: string; ttl: number | null } | null;

      if (!result) {
        return null;
      }

      // 检查 TTL
      if (result.ttl !== null && result.ttl < now) {
        // 已过期，惰性删除
        this.delete(key).catch(err => {
          logger.error({ error: err, pluginName: this.pluginName, key }, 'Failed to delete expired key');
        });
        return null;
      }

      const value = JSON.parse(result.value);

      // 将数据加载到缓存
      if (this.cache && result.ttl) {
        const ttlSeconds = result.ttl - now;
        this.cache.set(key, value, ttlSeconds > 0 ? ttlSeconds : undefined);
      } else if (this.cache) {
        this.cache.set(key, value);
      }

      return value;
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to get value from storage');
      return null;
    }
  }

  /**
   * 设置值
   */
  async set(key: string, value: any, ttlSeconds?: number): Promise<void> {
    try {
      // 如果有缓存，写入缓存（Write-Behind）
      if (this.cache) {
        this.cache.set(key, value, ttlSeconds);
        return; // 缓存会异步写回数据库
      }

      // 无缓存时，直接写入数据库
      const now = Math.floor(Date.now() / 1000);
      const ttl = ttlSeconds ? now + ttlSeconds : null;
      const serializedValue = JSON.stringify(value);

      const stmt = this.db.query(`
        INSERT OR REPLACE INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);

      stmt.run(this.pluginName, key, serializedValue, ttl, now * 1000);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to set value in storage');
      throw error;
    }
  }

  /**
   * 删除值
   */
  async delete(key: string): Promise<void> {
    try {
      // 从缓存中删除
      if (this.cache) {
        this.cache.remove(key);
      }

      // 从数据库中删除
      const stmt = this.db.query(`
        DELETE FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      stmt.run(this.pluginName, key);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName, key }, 'Failed to delete value from storage');
      throw error;
    }
  }

  /**
   * 获取所有键
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      const now = Math.floor(Date.now() / 1000);
      let sql = `
        SELECT key FROM plugin_storage
        WHERE plugin_name = ?
        AND (ttl IS NULL OR ttl >= ?)
      `;
      const params: any[] = [this.pluginName, now];

      if (prefix) {
        sql += ` AND key LIKE ?`;
        params.push(`${prefix}%`);
      }

      const query = this.db.query(sql);
      const results = query.all(...params) as { key: string }[];

      return results.map(r => r.key);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName }, 'Failed to list keys');
      return [];
    }
  }

  /**
   * 清空存储
   */
  async clear(): Promise<void> {
    try {
      // 先清空缓存
      if (this.cache) {
        await this.cache.clear();
      }

      // 清空数据库
      const stmt = this.db.query(`
        DELETE FROM plugin_storage
        WHERE plugin_name = ?
      `);

      stmt.run(this.pluginName);
    } catch (error) {
      logger.error({ error, pluginName: this.pluginName }, 'Failed to clear storage');
      throw error;
    }
  }

  /**
   * 刷新缓存到数据库
   * 强制将所有dirty数据写回
   */
  async flush(): Promise<void> {
    if (this.cache) {
      await this.cache.flush();
    }
  }

  /**
   * 获取缓存统计信息
   */
  getCacheStats() {
    if (!this.cache) {
      return null;
    }
    return this.cache.getStats();
  }

  /**
   * 重置缓存统计信息
   */
  resetCacheStats(): void {
    if (this.cache) {
      this.cache.resetStats();
    }
  }

  /**
   * 原子递增操作
   * 使用 SQLite 的 json_set 函数实现原子操作
   */
  async increment(key: string, field: string, delta: number = 1): Promise<number> {
    try {
      validateJsonField(field);
      const now = Math.floor(Date.now() / 1000);
      const path = `$.${field}`;

      // 使用 UPSERT + json_set 实现原子递增
      const stmt = this.db.query(`
        INSERT INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
        VALUES (
          ?,
          ?,
          json_object(?, ?),
          NULL,
          ?
        )
        ON CONFLICT(plugin_name, key) DO UPDATE SET
          value = json_set(
            value,
            ?,
            COALESCE(json_extract(value, ?), 0) + ?
          ),
          updated_at = excluded.updated_at
        RETURNING json_extract(value, ?) as result
      `);

      const result = stmt.get(
        this.pluginName,
        key,
        field,
        delta,
        now * 1000,
        path,
        path,
        delta,
        path
      ) as { result: number } | null;

      return result?.result ?? delta;
    } catch (error) {
      logger.error(
        { error, pluginName: this.pluginName, key, field, delta },
        'Failed to increment value'
      );
      throw error;
    }
  }

  /**
   * 比较并交换操作
   * 仅当当前值等于期望值时，才更新为新值
   */
  async compareAndSet(
    key: string,
    field: string,
    expected: any,
    newValue: any
  ): Promise<boolean> {
    try {
      validateJsonField(field);
      const now = Math.floor(Date.now() / 1000);
      const path = `$.${field}`;
      const expectedJson = JSON.stringify(expected);
      const newValueJson = JSON.stringify(newValue);

      // 查询当前值
      const getCurrentStmt = this.db.query(`
        SELECT json_extract(value, ?) as currentValue
        FROM plugin_storage
        WHERE plugin_name = ? AND key = ?
      `);

      const current = getCurrentStmt.get(path, this.pluginName, key) as
        | { currentValue: any }
        | null;

      // 如果记录不存在，且期望值为null，则插入新记录
      if (!current && expected === null) {
        const insertStmt = this.db.query(`
          INSERT INTO plugin_storage (plugin_name, key, value, ttl, updated_at)
          VALUES (?, ?, json_object(?, json(?)), NULL, ?)
        `);
        insertStmt.run(this.pluginName, key, field, newValueJson, now * 1000);
        return true;
      }

      // 如果记录不存在，但期望值不为null，则CAS失败
      if (!current && expected !== null) {
        return false;
      }

      // 记录存在，比较当前值
      const currentValueJson = JSON.stringify(current!.currentValue);
      if (currentValueJson !== expectedJson) {
        return false;
      }

      // CAS成功，更新值
      const updateStmt = this.db.query(`
        UPDATE plugin_storage
        SET value = json_set(value, ?, json(?)),
            updated_at = ?
        WHERE plugin_name = ? AND key = ?
        AND json_extract(value, ?) = json_extract(?, '$')
      `);

      const result = updateStmt.run(
        path,
        newValueJson,
        now * 1000,
        this.pluginName,
        key,
        path,
        expectedJson
      );

      return result.changes > 0;
    } catch (error) {
      logger.error(
        { error, pluginName: this.pluginName, key, field },
        'Failed to compare and set value'
      );
      throw error;
    }
  }
}

const TOKEN_STATS_PLUGIN_NAME = 'token-stats';
const TOKEN_STATS_METRICS: readonly TokenStatsMetricName[] = [
  'inputTokens', 'outputTokens', 'officialInputTokens', 'officialOutputTokens',
  'estimatedInputTokens', 'estimatedOutputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'partialOutputs', 'logicalRequests', 'upstreamAttempts', 'observationIncompleteAttempts',
  'inputAuthorityOfficial', 'inputAuthorityLocal', 'inputAuthorityHeuristic', 'inputAuthorityPartial', 'inputAuthorityNone',
  'outputAuthorityOfficial', 'outputAuthorityLocal', 'outputAuthorityHeuristic', 'outputAuthorityPartial', 'outputAuthorityNone',
];
const TOKEN_STATS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TOKEN_STATS_MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const TOKEN_STATS_BUSY_TIMEOUT_MS = 5;

const EMPTY_METRICS: Record<TokenStatsMetricName, number> = Object.fromEntries(
  TOKEN_STATS_METRICS.map((name) => [name, 0]),
) as Record<TokenStatsMetricName, number>;

class SQLiteTokenStatsMetering implements TokenStatsMeteringStorage {
  constructor(private readonly db: Database) {}

  async recordAttempt(row: TokenStatsAttempt): Promise<void> {
    validateTokenStatsAttempt(row);
    const transaction = this.db.transaction(() => {
      this.db.query(`
        INSERT OR IGNORE INTO token_stats_attempts (
          attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model,
          input_tokens, output_tokens, input_source, output_source,
          cache_read_tokens, cache_write_tokens, cost_usd, observation_incomplete
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.attempt_id, row.request_id, row.finished_at_ms, row.route_id, row.upstream_id, row.provider,
        row.outcome, row.model, row.input_tokens, row.output_tokens, row.input_source, row.output_source,
        row.cache_read_tokens, row.cache_write_tokens, row.cost_usd, row.observation_incomplete ? 1 : 0,
      );
      // A fixed one-batch cleanup keeps the write transaction bounded.
      this.db.query(`
        DELETE FROM token_stats_attempts WHERE attempt_id IN (
          SELECT attempt_id FROM token_stats_attempts INDEXED BY idx_token_stats_attempts_finished
          WHERE finished_at_ms < ? ORDER BY finished_at_ms LIMIT 500
        )
      `).run(Date.now() - TOKEN_STATS_RETENTION_MS);
    });
    const busyTimeout = this.db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout;
    if (!Number.isSafeInteger(busyTimeout) || busyTimeout! < 0) throw new Error('unable to read SQLite busy_timeout');
    try {
      this.db.run(`PRAGMA busy_timeout = ${TOKEN_STATS_BUSY_TIMEOUT_MS}`);
      transaction.immediate();
    } finally {
      this.db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
    }
  }

  async queryWindowSnapshot(input: {
    asOfMs: number;
    range: TokenStatsRange;
    groupBy: TokenStatsGroupBy;
    timeZone?: string;
  }): Promise<{
    all: TokenStatsSnapshotMetrics;
    data: Array<{ dimension: string; bucketStartMs?: number; metrics: TokenStatsSnapshotMetrics }>;
    bucketMs?: number;
    bucketStarts?: number[];
    bucketEndMs?: number;
    present: boolean;
  }> {
    validateTokenStatsTimestamp(input.asOfMs, 'asOfMs');
    if (!(TOKEN_STATS_RANGES as readonly string[]).includes(input.range)) throw new Error('invalid token-stats range');
    if (!['model', 'time'].includes(input.groupBy)) throw new Error('invalid token-stats groupBy');
    const window = tokenStatsWindow(input.range, input.asOfMs, input.timeZone);
    const startMs = Math.max(window.startMs, Date.now() - TOKEN_STATS_RETENTION_MS);
    const bucketMs = input.groupBy === 'time' ? window.bucketMs : undefined;
    const bucketStarts = input.groupBy === 'time' ? window.bucketStarts : undefined;
    const bucketEndMs = input.groupBy === 'time' ? window.bucketEndMs : undefined;
    const { sql, params } = buildTokenStatsWindowSnapshotQuery({ ...window, startMs, groupBy: input.groupBy, bucketMs, bucketStarts });
    const rows = this.db.query<Record<string, number | string | null>, number[]>(sql).all(...params);
    const allRow = rows.find((row) => row.kind === 'all');
    const dataRows = rows.filter((row) => row.kind === 'data');
    const metrics = (row: Record<string, number | string | null> | undefined): TokenStatsSnapshotMetrics => {
      const base = !row ? { ...EMPTY_METRICS } : Object.fromEntries(TOKEN_STATS_METRICS.map((key) => {
        const value = Number(row[key] ?? 0);
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`invalid token-stats aggregate: ${key}`);
        return [key, value];
      })) as Record<TokenStatsMetricName, number>;
      const rawCost = row?.estimatedCostUsd;
      const estimatedCostUsd = rawCost === undefined || rawCost === null ? null : Number(rawCost);
      if (estimatedCostUsd !== null && (!Number.isFinite(estimatedCostUsd) || estimatedCostUsd < 0)) {
        throw new RangeError('invalid token-stats aggregate: estimatedCostUsd');
      }
      return { ...base, estimatedCostUsd };
    };
    return {
      all: metrics(allRow),
      data: dataRows.map((row) => ({
        dimension: String(row.dimension),
        ...(input.groupBy === 'time' ? { bucketStartMs: Number(row.bucketStartMs) } : {}),
        metrics: metrics(row),
      })),
      ...(bucketMs === undefined ? {} : { bucketMs }),
      ...(bucketStarts === undefined ? {} : { bucketStarts }),
      ...(bucketEndMs === undefined ? {} : { bucketEndMs }),
      present: Number(allRow?.present ?? 0) === 1,
    };
  }
}

export function buildTokenStatsWindowSnapshotQuery(input: {
  startMs: number;
  endMs: number;
  groupBy: TokenStatsGroupBy;
  bucketMs?: number;
  bucketStarts?: readonly number[];
}): { sql: string; params: number[] } {
  const metrics = (alias: string) => `
    COALESCE(SUM(CASE WHEN ${alias}.input_source = 'usage' THEN ${alias}.input_tokens ELSE 0 END), 0) AS officialInputTokens,
    COALESCE(SUM(CASE WHEN ${alias}.output_source = 'usage' THEN ${alias}.output_tokens ELSE 0 END), 0) AS officialOutputTokens,
    COALESCE(SUM(CASE WHEN ${alias}.input_source IN ('estimated', 'partial') THEN ${alias}.input_tokens ELSE 0 END), 0) AS estimatedInputTokens,
    COALESCE(SUM(CASE WHEN ${alias}.output_source IN ('estimated', 'partial') THEN ${alias}.output_tokens ELSE 0 END), 0) AS estimatedOutputTokens,
    COALESCE(SUM(CASE WHEN ${alias}.input_source IN ('usage', 'estimated', 'partial') THEN ${alias}.input_tokens ELSE 0 END), 0) AS inputTokens,
    COALESCE(SUM(CASE WHEN ${alias}.output_source IN ('usage', 'estimated', 'partial') THEN ${alias}.output_tokens ELSE 0 END), 0) AS outputTokens,
    COALESCE(SUM(${alias}.cache_read_tokens), 0) AS cacheReadTokens,
    COALESCE(SUM(${alias}.cache_write_tokens), 0) AS cacheWriteTokens,
    SUM(${alias}.cost_usd) AS estimatedCostUsd,
    SUM(CASE WHEN ${alias}.observation_incomplete = 1 AND ${alias}.output_source = 'usage' THEN 1 ELSE 0 END) AS partialOutputs,
    COUNT(DISTINCT ${alias}.request_id) AS logicalRequests,
    COUNT(*) AS upstreamAttempts,
    SUM(${alias}.observation_incomplete) AS observationIncompleteAttempts,
    SUM(${alias}.input_source = 'usage') AS inputAuthorityOfficial,
    0 AS inputAuthorityLocal, SUM(${alias}.input_source = 'estimated') AS inputAuthorityHeuristic,
    SUM(${alias}.input_source = 'partial') AS inputAuthorityPartial, SUM(${alias}.input_source = 'unknown') AS inputAuthorityNone,
    SUM(${alias}.output_source = 'usage') AS outputAuthorityOfficial,
    0 AS outputAuthorityLocal, SUM(${alias}.output_source = 'estimated') AS outputAuthorityHeuristic,
    SUM(${alias}.output_source = 'partial') AS outputAuthorityPartial, SUM(${alias}.output_source = 'unknown') AS outputAuthorityNone`;
  if (input.groupBy === 'time' && (!Number.isSafeInteger(input.bucketMs) || input.bucketMs! <= 0)) {
    throw new Error('invalid token-stats bucketMs');
  }
  if (input.bucketStarts && (!input.bucketStarts.length || input.bucketStarts.length > 31
    || input.bucketStarts.some((start, i, starts) => !Number.isSafeInteger(start) || start < 0 || i > 0 && start <= starts[i - 1]!))) {
    throw new Error('invalid token-stats bucketStarts');
  }
  const origin = input.bucketStarts?.[0] ?? 0;
  const uniform = !input.bucketStarts || input.bucketStarts.every((start, i) => start === origin + i * input.bucketMs!);
  const bucketStart = input.groupBy !== 'time' ? 'NULL' : uniform
    ? `CAST((attempt.finished_at_ms - ${origin}) / ${input.bucketMs} AS INTEGER) * ${input.bucketMs} + ${origin}`
    : `CASE ${[...input.bucketStarts!].reverse().map(start => `WHEN attempt.finished_at_ms >= ${start} THEN ${start}`).join(' ')} END`;
  const groupColumns = input.groupBy === 'time' ? `attempt.model, bucketStartMs` : 'attempt.model';
  const grouped = `
    UNION ALL
    SELECT 'data' AS kind, attempt.model AS dimension, ${bucketStart} AS bucketStartMs, ${metrics('attempt')}, 0 AS present
    FROM window_rows AS attempt GROUP BY ${groupColumns}`;
  return {
    sql: `
      WITH window_rows AS MATERIALIZED (
        SELECT * FROM token_stats_attempts INDEXED BY idx_token_stats_attempts_finished
        WHERE finished_at_ms >= ? AND finished_at_ms < ?
      )
      SELECT 'all' AS kind, 'all' AS dimension, NULL AS bucketStartMs, ${metrics('attempt')}, (COUNT(*) > 0) AS present
      FROM window_rows AS attempt
      ${grouped}
      ORDER BY kind, bucketStartMs, dimension
    `,
    params: [input.startMs, input.endMs],
  };
}

function validateTokenStatsAttempt(row: TokenStatsAttempt): void {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid token-stats attempt');
  for (const key of ['attempt_id', 'request_id', 'route_id', 'upstream_id', 'provider', 'outcome', 'model'] as const) {
    if (typeof row[key] !== 'string' || row[key].length === 0) throw new Error(`invalid token-stats ${key}`);
  }
  validateTokenStatsTimestamp(row.finished_at_ms, 'finished_at_ms');
  for (const [key, value] of [
    ['input_tokens', row.input_tokens], ['output_tokens', row.output_tokens],
    ['cache_read_tokens', row.cache_read_tokens], ['cache_write_tokens', row.cache_write_tokens],
  ] as const) {
    if (value !== null && (!Number.isSafeInteger(value) || value < 0)) throw new Error(`invalid token-stats ${key}`);
  }
  if (row.cost_usd !== null && (!Number.isFinite(row.cost_usd) || row.cost_usd < 0)) throw new Error('invalid token-stats cost_usd');
  if (!isTokenStatsSource(row.input_source) || !isTokenStatsSource(row.output_source)) throw new Error('invalid token-stats value source');
  if (typeof row.observation_incomplete !== 'boolean') throw new Error('invalid token-stats observation_incomplete');
  if ((row.input_source === 'unknown') !== (row.input_tokens === null)
    || (row.output_source === 'unknown') !== (row.output_tokens === null)) throw new Error('token-stats value/source mismatch');
}

function isTokenStatsSource(value: unknown): value is TokenStatsValueSource {
  return value === 'usage' || value === 'estimated' || value === 'partial' || value === 'unknown';
}

function validateTokenStatsTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid token-stats ${name}`);
  const now = Date.now();
  if (value < now - TOKEN_STATS_RETENTION_MS) throw new RangeError(`token-stats ${name} exceeds 31-day retention`);
  if (value > now + TOKEN_STATS_MAX_FUTURE_SKEW_MS) throw new RangeError(`token-stats ${name} is too far in the future`);
}

function validateJsonField(field: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(field)) {
    throw new Error('invalid plugin storage JSON field');
  }
}

export class PluginStorageRevokedError extends Error {
  readonly name = 'PluginStorageRevokedError';
  constructor() { super('plugin storage capability is revoked'); }
}

export type PluginStorageCapability = {
  readonly storage: PluginStorage;
  readonly revoke: () => void;
};

/** Returns a storage capability whose database and namespace remain in the closure. */
export function createPluginStorageCapability(db: Database, pluginName: string): PluginStorageCapability {
  const implementation = new SQLitePluginStorage(db, pluginName);
  let revoked = false;
  const assertActive = (): void => {
    if (revoked) throw new PluginStorageRevokedError();
  };
  const storage = Object.freeze({
    ...(pluginName === 'token-stats' && implementation.metering ? {
      metering: Object.freeze({
        recordAttempt: async (row: TokenStatsAttempt): Promise<void> => {
          assertActive();
          return implementation.metering!.recordAttempt(row);
        },
        queryWindowSnapshot: async (input: Parameters<TokenStatsMeteringStorage['queryWindowSnapshot']>[0]): Promise<Awaited<ReturnType<TokenStatsMeteringStorage['queryWindowSnapshot']>>> => {
          assertActive();
          return implementation.metering!.queryWindowSnapshot(input);
        },
      }),
    } : {}),
    get: async <T = any>(key: string): Promise<T | null> => {
      assertActive();
      return implementation.get<T>(key);
    },
    set: async (key: string, value: any, ttlSeconds?: number): Promise<void> => {
      assertActive();
      return implementation.set(key, value, ttlSeconds);
    },
    delete: async (key: string): Promise<void> => {
      assertActive();
      return implementation.delete(key);
    },
    keys: async (prefix?: string): Promise<string[]> => {
      assertActive();
      return implementation.keys(prefix);
    },
    clear: async (): Promise<void> => {
      assertActive();
      return implementation.clear();
    },
    increment: async (key: string, field: string, delta?: number): Promise<number> => {
      assertActive();
      return implementation.increment(key, field, delta);
    },
    compareAndSet: async (key: string, field: string, expected: any, newValue: any): Promise<boolean> => {
      assertActive();
      return implementation.compareAndSet(key, field, expected, newValue);
    },
  }) satisfies PluginStorage;
  return { storage, revoke: () => { revoked = true; } };
}
