import type {
  PluginStorage,
  TokenStatsAttempt,
  TokenStatsMetricName,
  TokenStatsMeteringStorage,
  TokenStatsSnapshotMetrics,
  TokenStatsRange,
} from '../../../packages/core/src/plugin.types';
import { TOKEN_ACCOUNTING_AUTHORITIES, type CanonicalTokenAccountingEventV2 } from '@jeffusion/bungee-llms/plugin-api';
import { TOKEN_STATS_RANGES } from '../../../packages/core/src/token-stats-window';

export type GroupByDimension = 'model' | 'time';
type TokenAccountingAuthority = typeof TOKEN_ACCOUNTING_AUTHORITIES[number];
export type CanonicalEvent = CanonicalTokenAccountingEventV2;

export interface AuthorityBreakdownDto {
  input: Record<TokenAccountingAuthority, number>;
  output: Record<TokenAccountingAuthority, number>;
}

export interface GroupedAggregateDto {
  dimension: string;
  bucketStartMs?: number;
  inputTokens: number;
  outputTokens: number;
  officialInputTokens: number;
  officialOutputTokens: number;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  partialOutputs: number;
  logicalRequests: number;
  upstreamAttempts: number;
  observationIncompleteAttempts: number;
  estimatedCostUsd: number | null;
  authorityBreakdown: AuthorityBreakdownDto;
}

export interface AggregateDto extends Omit<GroupedAggregateDto, 'dimension' | 'bucketStartMs' | 'inputTokens' | 'outputTokens'> {
  groupBy: GroupByDimension;
  asOfMs: number;
  bucketMs?: number;
  bucketStarts?: number[];
  totalInputTokens: number;
  totalOutputTokens: number;
  data: GroupedAggregateDto[];
}

export class TokenStatsRepositoryError extends Error {
  constructor(message: string) { super(message); this.name = 'TokenStatsRepositoryError'; }
}

export class TokenStatsRepositoryLimitError extends TokenStatsRepositoryError {}

type MeteringLogger = { warn(message: string, metadata?: object): void; error(message: string, metadata?: object): void };
type AttemptTask = () => TokenStatsAttempt | undefined | Promise<TokenStatsAttempt | undefined>;
type QueuedAttempt = { metering: TokenStatsMeteringStorage; task: AttemptTask; logger: MeteringLogger };

const MAX_PENDING_ATTEMPTS = 256;
const LOG_INTERVAL_MS = 60_000;
const pendingAttempts: QueuedAttempt[] = [];
let pendingCount = 0;
let drainTimer: ReturnType<typeof setTimeout> | undefined;
let draining = false;
let lastDropLogAt = 0;
let lastFailureLogAt = 0;

function logRateLimited(logger: MeteringLogger, kind: 'drop' | 'failure', error?: unknown): void {
  const now = Date.now();
  if (kind === 'drop') {
    if (now - lastDropLogAt < LOG_INTERVAL_MS) return;
    lastDropLogAt = now;
    try { logger.warn('Token stats attempt queue full; dropping metering rows', { capacity: MAX_PENDING_ATTEMPTS }); } catch { /* logging must not affect proxy flow */ }
    return;
  }
  if (now - lastFailureLogAt < LOG_INTERVAL_MS) return;
  lastFailureLogAt = now;
  try {
    logger.error('Token stats attempt processing failed; dropping metering row', {
      error: error instanceof Error ? error.message : error === undefined ? 'attempt task returned no row' : String(error),
    });
  } catch { /* logging must not affect proxy flow */ }
}

function scheduleDrain(): void {
  if (drainTimer !== undefined || draining) return;
  drainTimer = setTimeout(() => { drainTimer = undefined; void drainOneAttempt(); }, 0);
}

async function drainOneAttempt(): Promise<void> {
  if (draining) return;
  const item = pendingAttempts.shift();
  if (!item) return;
  draining = true;
  try {
    try {
      const row = await item.task();
      if (row === undefined) {
        logRateLimited(item.logger, 'failure');
      } else {
        await item.metering.recordAttempt(row);
      }
    } catch (error) {
      logRateLimited(item.logger, 'failure', error);
    }
  } finally {
    pendingCount--;
    draining = false;
    if (pendingAttempts.length) scheduleDrain();
  }
}

const METRIC_FIELDS: readonly TokenStatsMetricName[] = [
  'inputTokens', 'outputTokens', 'officialInputTokens', 'officialOutputTokens',
  'estimatedInputTokens', 'estimatedOutputTokens', 'cacheReadTokens', 'cacheWriteTokens',
  'partialOutputs', 'logicalRequests', 'upstreamAttempts', 'observationIncompleteAttempts',
  'inputAuthorityOfficial', 'inputAuthorityLocal', 'inputAuthorityHeuristic', 'inputAuthorityPartial', 'inputAuthorityNone',
  'outputAuthorityOfficial', 'outputAuthorityLocal', 'outputAuthorityHeuristic', 'outputAuthorityPartial', 'outputAuthorityNone',
];

function emptyMetrics(): TokenStatsSnapshotMetrics {
  return { ...Object.fromEntries(METRIC_FIELDS.map((key) => [key, 0])) as Record<TokenStatsMetricName, number>, estimatedCostUsd: null };
}

function emptyAuthorityBreakdown(): AuthorityBreakdownDto {
  const empty = () => Object.fromEntries(TOKEN_ACCOUNTING_AUTHORITIES.map((authority) => [authority, 0])) as Record<TokenAccountingAuthority, number>;
  return { input: empty(), output: empty() };
}

function metricsToDto(metrics: TokenStatsSnapshotMetrics): Omit<GroupedAggregateDto, 'dimension'> {
  const authorityBreakdown = emptyAuthorityBreakdown();
  for (const authority of TOKEN_ACCOUNTING_AUTHORITIES) {
    authorityBreakdown.input[authority] = metrics[`inputAuthority${authority[0]!.toUpperCase()}${authority.slice(1)}` as TokenStatsMetricName];
    authorityBreakdown.output[authority] = metrics[`outputAuthority${authority[0]!.toUpperCase()}${authority.slice(1)}` as TokenStatsMetricName];
  }
  return {
    inputTokens: metrics.inputTokens,
    outputTokens: metrics.outputTokens,
    officialInputTokens: metrics.officialInputTokens,
    officialOutputTokens: metrics.officialOutputTokens,
    estimatedInputTokens: metrics.estimatedInputTokens,
    estimatedOutputTokens: metrics.estimatedOutputTokens,
    cacheReadTokens: metrics.cacheReadTokens,
    cacheWriteTokens: metrics.cacheWriteTokens,
    partialOutputs: metrics.partialOutputs,
    logicalRequests: metrics.logicalRequests,
    upstreamAttempts: metrics.upstreamAttempts,
    observationIncompleteAttempts: metrics.observationIncompleteAttempts,
    estimatedCostUsd: metrics.estimatedCostUsd,
    authorityBreakdown,
  };
}

function sourceFor(value: number | undefined, authority: CanonicalTokenAccountingEventV2['inputAuthority']): TokenStatsAttempt['input_source'] {
  if (!Number.isSafeInteger(value) || value! < 0) return 'unknown';
  if (authority === 'official') return 'usage';
  if (authority === 'partial') return 'partial';
  return authority === 'none' ? 'unknown' : 'estimated';
}

export function attemptRowFromEvent(
  event: CanonicalEvent,
  finishedAtMs: number,
  observationIncomplete: boolean,
  model: string,
): TokenStatsAttempt {
  const inputSource = sourceFor(event.inputTokens, event.inputAuthority);
  const outputSource = sourceFor(event.outputTokens, event.outputAuthority);
  return {
    attempt_id: event.attemptId,
    request_id: event.requestId,
    finished_at_ms: finishedAtMs,
    route_id: event.routeId || 'unknown',
    upstream_id: event.upstreamId || 'unknown',
    provider: event.provider || 'unknown',
    outcome: event.outcome,
    model,
    input_tokens: inputSource === 'unknown' ? null : event.inputTokens!,
    output_tokens: outputSource === 'unknown' ? null : event.outputTokens!,
    input_source: inputSource,
    output_source: outputSource,
    cache_read_tokens: Number.isSafeInteger(event.cacheReadTokens) && event.cacheReadTokens! >= 0 ? event.cacheReadTokens! : null,
    cache_write_tokens: Number.isSafeInteger(event.cacheWriteTokens) && event.cacheWriteTokens! >= 0 ? event.cacheWriteTokens! : null,
    cost_usd: null,
    observation_incomplete: observationIncomplete,
  };
}

export class TokenStatsRepository {
  private readonly metering: TokenStatsMeteringStorage;

  constructor(storage: PluginStorage) {
    if (!storage.metering) throw new TokenStatsRepositoryError('token-stats metering storage is required');
    this.metering = storage.metering;
  }

  /** Defers synchronous task work to drain; a task can still occupy the EventLoop. */
  enqueueAttempt(task: AttemptTask, logger: MeteringLogger): boolean {
    if (pendingCount >= MAX_PENDING_ATTEMPTS) {
      logRateLimited(logger, 'drop');
      return false;
    }
    pendingAttempts.push({ metering: this.metering, task, logger });
    pendingCount++;
    scheduleDrain();
    return true;
  }

  async query(range: string, groupBy: GroupByDimension, asOfMs = Date.now(), timeZone?: string): Promise<AggregateDto> {
    if (!(TOKEN_STATS_RANGES as readonly string[]).includes(range)) throw new TokenStatsRepositoryError('invalid token-stats range');
    if (groupBy !== 'model' && groupBy !== 'time') {
      throw new TokenStatsRepositoryError('invalid token-stats groupBy');
    }
    if (!Number.isSafeInteger(asOfMs) || asOfMs < 0) throw new TokenStatsRepositoryError('invalid token-stats asOfMs');
    const snapshot = await this.metering.queryWindowSnapshot({ asOfMs, range: range as TokenStatsRange, groupBy, timeZone });
    const total = metricsToDto(snapshot.all);
    const { inputTokens, outputTokens, ...summary } = total;
    return {
      groupBy,
      asOfMs,
      ...summary,
      totalInputTokens: inputTokens,
      totalOutputTokens: outputTokens,
      ...(snapshot.bucketMs === undefined ? {} : { bucketMs: snapshot.bucketMs }),
      ...(snapshot.bucketStarts === undefined ? {} : { bucketStarts: snapshot.bucketStarts }),
      data: snapshot.data.map((row) => ({
        dimension: row.dimension,
        ...(row.bucketStartMs === undefined ? {} : { bucketStartMs: row.bucketStartMs }),
        ...metricsToDto(row.metrics),
      })).sort(groupBy === 'model'
        ? (a, b) => b.inputTokens + b.outputTokens - a.inputTokens - a.outputTokens
          || b.upstreamAttempts - a.upstreamAttempts || a.dimension.localeCompare(b.dimension)
        : (a, b) => a.bucketStartMs! - b.bucketStartMs! || a.dimension.localeCompare(b.dimension)),
    };
  }
}
