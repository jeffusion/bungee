import type { Database } from 'bun:sqlite';
import type { PluginStorage, PluginObservationStorage, TokenStatsAttempt, TokenStatsGroupBy, TokenStatsMeteringStorage,
  TokenStatsMetricName, TokenStatsSnapshotMetrics, TokenStatsValueSource, TokenStatsRange } from '@jeffusion/bungee-core/plugin';
import { TOKEN_STATS_RETENTION_MS, TOKEN_STATS_RANGES, tokenStatsWindow } from '@jeffusion/bungee-core/plugin';
import type { ModelsDevModelMatch } from '../../models-dev/contract';
import { costNanoUsdOf, costOf } from './pricing';

/** Explicit assembly for legacy fixtures and embedders; the host never checks a business name. */
export function withTokenStatsMetering<T extends PluginStorage>(storage: T): T & { metering: SQLiteTokenStatsMetering } {
  if (!storage.observation) throw new Error('token-stats metering storage is required');
  return Object.assign(storage, { metering: new SQLiteTokenStatsMetering(storage.observation) });
}

const TOKEN_STATS_METRICS: readonly TokenStatsMetricName[] = [
  'inputTokens', 'outputTokens', 'officialInputTokens', 'officialOutputTokens',
  'estimatedInputTokens', 'estimatedOutputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'partialOutputs', 'logicalRequests', 'upstreamAttempts', 'observationIncompleteAttempts',
  'inputAuthorityOfficial', 'inputAuthorityLocal', 'inputAuthorityHeuristic', 'inputAuthorityPartial', 'inputAuthorityNone',
  'outputAuthorityOfficial', 'outputAuthorityLocal', 'outputAuthorityHeuristic', 'outputAuthorityPartial', 'outputAuthorityNone',
];
const TOKEN_STATS_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const TOKEN_STATS_BUSY_TIMEOUT_MS = 5;

const EMPTY_METRICS: Record<TokenStatsMetricName, number> = Object.fromEntries(
  TOKEN_STATS_METRICS.map((name) => [name, 0]),
) as Record<TokenStatsMetricName, number>;

type WindowQuery = Parameters<TokenStatsMeteringStorage['queryWindowSnapshot']>[0];
type QueryPricing = {
  throughRow: number;
  prices: readonly (readonly [string, ModelsDevModelMatch])[];
};
type UnpricedUsage = Pick<TokenStatsAttempt, 'model' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_write_tokens'> & {
  bucketStartMs: number | null;
};
const PRICEABLE_USAGE = `cost_usd IS NULL AND input_tokens IS NOT NULL AND output_tokens IS NOT NULL AND model <> 'unknown'`;

export class SQLiteTokenStatsMetering implements TokenStatsMeteringStorage {
  constructor(private readonly observation: PluginObservationStorage) {}

  async recordAttempt(row: TokenStatsAttempt): Promise<void> {
    return this.observation.withDatabase((db) => {
      validateTokenStatsAttempt(row);
      const transaction = db.transaction(() => {
        db.query(`
          INSERT OR IGNORE INTO token_stats_attempts (
            attempt_id, request_id, finished_at_ms, route_id, upstream_id, provider, outcome, model, key_id,
            input_tokens, output_tokens, input_source, output_source,
            cache_read_tokens, cache_write_tokens, cost_usd, observation_incomplete
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          row.attempt_id, row.request_id, row.finished_at_ms, row.route_id, row.upstream_id, row.provider,
          row.outcome, row.model, row.key_id ?? null, row.input_tokens, row.output_tokens, row.input_source, row.output_source,
          row.cache_read_tokens, row.cache_write_tokens, row.cost_usd, row.observation_incomplete ? 1 : 0,
        );
        // A fixed one-batch cleanup keeps the write transaction bounded.
        db.query(`
          DELETE FROM token_stats_attempts WHERE attempt_id IN (
            SELECT attempt_id FROM token_stats_attempts INDEXED BY idx_token_stats_attempts_finished
            WHERE finished_at_ms < ? ORDER BY finished_at_ms LIMIT 500
          )
        `).run(Date.now() - TOKEN_STATS_RETENTION_MS);
      });
      withReportingWriteTimeout(db, () => transaction.immediate());
    });
  }

  async queryPricingModels(input: WindowQuery): Promise<{ models: string[]; throughRow: number }> {
    const window = queryBounds(input);
    return this.observation.withDatabase((db) => db.transaction(() => {
      // Do not include newly inserted rows between the model lookup and the priced query.
      const { throughRow } = db.query<{ throughRow: number }, []>(
        'SELECT COALESCE(MAX(rowid), 0) AS throughRow FROM token_stats_attempts',
      ).get()!;
      const { index, where, params } = attemptWindow({ ...window, throughRow });
      const rows = db.query<{ model: string }, (number | string)[]>(`
        SELECT DISTINCT model FROM token_stats_attempts INDEXED BY ${index}
        WHERE ${where} AND ${PRICEABLE_USAGE}
      `).all(...params);
      return { models: rows.map(row => row.model), throughRow };
    }).deferred());
  }

  async queryWindowSnapshot(input: WindowQuery & { pricing?: QueryPricing }): Promise<{
    all: TokenStatsSnapshotMetrics;
    data: Array<{ dimension: string; bucketStartMs?: number; metrics: TokenStatsSnapshotMetrics }>;
    bucketMs?: number;
    bucketStarts?: number[];
    bucketEndMs?: number;
    present: boolean;
  }> {
    const window = queryBounds(input);
    const { bucketMs, bucketStarts, bucketEndMs } = window;
    const pricing = input.pricing;
    const { sql, params, missingSql } = buildTokenStatsWindowSnapshotQuery({ ...window, throughRow: pricing?.throughRow });
    return this.observation.withDatabase((db) => {
      const read = () => {
        const rows = db.query<Record<string, number | string | null>, (number | string)[]>(sql).all(...params);
        if (!pricing?.prices.length) return rows;
        const prices = new Map(pricing.prices);
        const missing = db.query<UnpricedUsage, (number | string)[]>(missingSql)
          .iterate(...params, JSON.stringify([...prices.keys()]));
        const byGroup = new Map<string, number>();
        let total: number | undefined;
        for (const row of missing) {
          const nano = costNanoUsdOf(costOf(prices.get(row.model)!, {
            inputTokens: row.input_tokens ?? undefined, outputTokens: row.output_tokens ?? undefined,
            cacheReadTokens: row.cache_read_tokens ?? undefined, cacheWriteTokens: row.cache_write_tokens ?? undefined,
          }));
          if (nano === null) continue;
          const cost = nano / 1e9;
          total = (total ?? 0) + cost;
          const key = JSON.stringify([row.model, row.bucketStartMs]);
          byGroup.set(key, (byGroup.get(key) ?? 0) + cost);
        }
        for (const row of rows) {
          const extra = row.kind === 'all' ? total : byGroup.get(JSON.stringify([row.dimension, row.bucketStartMs]));
          if (extra !== undefined) row.estimatedCostUsd = Number(row.estimatedCostUsd ?? 0) + extra;
        }
        return rows;
      };
      const rows = pricing?.prices.length ? db.transaction(read).deferred() : read();
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
    });
  }
  async listClientModels(input: {page?:number;pageSize?:number;keyword?:string}) {
    const page=input.page ?? 1,pageSize=input.pageSize ?? 20,keyword=input.keyword;
    if(!Number.isSafeInteger(page)||page<1||page>400||!Number.isSafeInteger(pageSize)||pageSize<1||pageSize>100
      || keyword!==undefined&&(typeof keyword!=='string'||keyword.length>256))throw new Error('invalid token-stats client models page');
    const since=Date.now()-TOKEN_STATS_RETENTION_MS;
    const search=keyword ? `%${keyword.replace(/[\\%_]/g, character=>`\\${character}`)}%` : null;
    return this.observation.withDatabase(db=>{
      const filter=search ? " AND model LIKE ? ESCAPE '\\'" : '';
      const params:(string|number)[]=search ? [since,search] : [since];
      const total=Number(db.query<{total:number},(string|number)[]>(`SELECT COUNT(DISTINCT model) AS total FROM token_stats_attempts WHERE finished_at_ms >= ?${filter}`).get(...params)?.total ?? 0);
      const rows=db.query<{model:string},(string|number)[]>(`SELECT DISTINCT model FROM token_stats_attempts WHERE finished_at_ms >= ?${filter} ORDER BY model ASC LIMIT ? OFFSET ?`).all(...params,pageSize,(page-1)*pageSize);
      return {models:rows.map(row=>String(row.model)),total:Number.isSafeInteger(total)&&total>=0 ? total : 0,page,pageSize};
    });
  }

}

function queryBounds(input: WindowQuery) {
  validateTokenStatsTimestamp(input.asOfMs, 'asOfMs');
  if (!(TOKEN_STATS_RANGES as readonly string[]).includes(input.range)) throw new Error('invalid token-stats range');
  if (!['model', 'time'].includes(input.groupBy)) throw new Error('invalid token-stats groupBy');
  const window = tokenStatsWindow(input.range, input.asOfMs, input.timeZone);
  return {
    ...window,
    startMs: Math.max(window.startMs, Date.now() - TOKEN_STATS_RETENTION_MS),
    groupBy: input.groupBy,
    bucketMs: input.groupBy === 'time' ? window.bucketMs : undefined,
    bucketStarts: input.groupBy === 'time' ? window.bucketStarts : undefined,
    bucketEndMs: input.groupBy === 'time' ? window.bucketEndMs : undefined,
    keyId: input.keyId,
  };
}

function attemptWindow(input: { startMs: number; endMs: number; keyId?: string; throughRow?: number }) {
  const { startMs, endMs, keyId, throughRow } = input;
  if (keyId !== undefined && (typeof keyId !== 'string' || !keyId || keyId.length > 128)) throw new Error('invalid token-stats keyId');
  if (throughRow !== undefined && (!Number.isSafeInteger(throughRow) || throughRow < 0)) throw new Error('invalid token-stats row boundary');
  const keyFilter = keyId === undefined ? '' : keyId === '__unattributed__' ? ' AND key_id IS NULL' : ' AND key_id = ?';
  return {
    index: keyId === undefined ? 'idx_token_stats_attempts_finished' : 'idx_token_stats_attempts_key_finished',
    where: `finished_at_ms >= ? AND finished_at_ms < ?${keyFilter}${throughRow === undefined ? '' : ' AND rowid <= ?'}`,
    params: [startMs, endMs, ...(keyId !== undefined && keyId !== '__unattributed__' ? [keyId] : []), ...(throughRow === undefined ? [] : [throughRow])],
  };
}

export function buildTokenStatsWindowSnapshotQuery(input: {
  startMs: number;
  endMs: number;
  groupBy: TokenStatsGroupBy;
  bucketMs?: number;
  bucketStarts?: readonly number[];
  keyId?: string;
  throughRow?: number;
}): { sql: string; missingSql: string; params: (number | string)[] } {
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
  const { index, where, params } = attemptWindow(input);
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
        SELECT * FROM token_stats_attempts INDEXED BY ${index}
        WHERE ${where}
      )
      SELECT 'all' AS kind, 'all' AS dimension, NULL AS bucketStartMs, ${metrics('attempt')}, (COUNT(*) > 0) AS present
      FROM window_rows AS attempt
      ${grouped}
      ORDER BY kind, bucketStartMs, dimension
    `,
    missingSql: `
      SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, ${bucketStart} AS bucketStartMs
      FROM token_stats_attempts AS attempt INDEXED BY ${index}
      WHERE ${where} AND ${PRICEABLE_USAGE} AND model IN (SELECT value FROM json_each(?))
    `,
    params,
  };
}

function validateTokenStatsAttempt(row: TokenStatsAttempt): void {
  if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('invalid token-stats attempt');
  for (const key of ['attempt_id', 'request_id', 'route_id', 'upstream_id', 'provider', 'outcome', 'model'] as const) {
    if (typeof row[key] !== 'string' || row[key].length === 0) throw new Error(`invalid token-stats ${key}`);
  }
  if (row.key_id != null && (typeof row.key_id !== 'string' || !row.key_id || row.key_id.length > 128)) throw new Error('invalid token-stats key_id');
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


/** Reporting writes have a short lock deadline and never retain a changed connection pragma. */
export function withReportingWriteTimeout<T>(db: Database, operation: () => T): T {
  const busyTimeout = db.query<{ timeout: number }, []>('PRAGMA busy_timeout').get()?.timeout;
  if (!Number.isSafeInteger(busyTimeout) || busyTimeout! < 0) throw new Error('unable to read SQLite busy_timeout');
  try {
    db.run(`PRAGMA busy_timeout = ${TOKEN_STATS_BUSY_TIMEOUT_MS}`);
    return operation();
  } finally {
    db.run(`PRAGMA busy_timeout = ${busyTimeout}`);
  }
}
