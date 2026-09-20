import type { PluginStorage } from '../../../packages/core/src/plugin.types';
import {
  TOKEN_ACCOUNTING_AUTHORITIES,
  type CanonicalTokenAccountingEventV2,
} from '@jeffusion/bungee-llms/plugin-api';

export type GroupByDimension = 'all' | 'route' | 'upstream' | 'provider';
type RangeKey = '1h' | '12h' | '24h';
type TokenAccountingAuthority = typeof TOKEN_ACCOUNTING_AUTHORITIES[number];

export const STORAGE_NAMESPACE = 'token-stats:v2:';
const MAX_STORAGE_ENTRIES = 4096;
const MAX_STORAGE_KEY_BYTES = 1024;
const MAX_STORAGE_ROW_BYTES = 16 * 1024;
const MAX_DIMENSION_BYTES = 512;
const textEncoder = new TextEncoder();

export type CanonicalEvent = CanonicalTokenAccountingEventV2;

export interface TokenStatsRecordState {
  routeId: string;
  attemptsStarted: number;
  attempts: Map<string, { upstreamId: string; provider: string }>;
  touchedUpstreams: Set<string>;
  touchedProviders: Set<string>;
}

interface StoredAggregateRow {
  inputTokens?: number;
  outputTokens?: number;
  logicalRequests?: number;
  upstreamAttempts?: number;
  officialInputTokens?: number;
  officialOutputTokens?: number;
  partialOutputs?: number;
  inputAuthorityOfficial?: number;
  inputAuthorityLocal?: number;
  inputAuthorityHeuristic?: number;
  inputAuthorityPartial?: number;
  inputAuthorityNone?: number;
  outputAuthorityOfficial?: number;
  outputAuthorityLocal?: number;
  outputAuthorityHeuristic?: number;
  outputAuthorityPartial?: number;
  outputAuthorityNone?: number;
}

export interface AuthorityBreakdownDto {
  input: Record<TokenAccountingAuthority, number>;
  output: Record<TokenAccountingAuthority, number>;
}

export interface GroupedAggregateDto {
  dimension: string;
  inputTokens: number;
  outputTokens: number;
  logicalRequests: number;
  upstreamAttempts: number;
  officialInputTokens: number;
  officialOutputTokens: number;
  partialOutputs: number;
  authorityBreakdown: AuthorityBreakdownDto;
}

export interface AggregateDto {
  groupBy: GroupByDimension;
  totalInputTokens: number;
  totalOutputTokens: number;
  logicalRequests: number;
  upstreamAttempts: number;
  authorityBreakdown: AuthorityBreakdownDto;
  data: GroupedAggregateDto[];
}

export class TokenStatsRepositoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TokenStatsRepositoryError';
  }
}

export class TokenStatsRepositoryLimitError extends TokenStatsRepositoryError {}

const ROW_FIELDS = [
  'inputTokens',
  'outputTokens',
  'logicalRequests',
  'upstreamAttempts',
  'officialInputTokens',
  'officialOutputTokens',
  'partialOutputs',
  'inputAuthorityOfficial',
  'inputAuthorityLocal',
  'inputAuthorityHeuristic',
  'inputAuthorityPartial',
  'inputAuthorityNone',
  'outputAuthorityOfficial',
  'outputAuthorityLocal',
  'outputAuthorityHeuristic',
  'outputAuthorityPartial',
  'outputAuthorityNone',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function readStoredRow(value: unknown): StoredAggregateRow {
  if (!isRecord(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !(ROW_FIELDS as readonly string[]).includes(key))) {
    throw new TokenStatsRepositoryError('invalid persisted token stats row');
  }

  for (const field of ROW_FIELDS) {
    const fieldValue = value[field];
    if (fieldValue !== undefined && (typeof fieldValue !== 'number' || !Number.isSafeInteger(fieldValue) || fieldValue < 0)) {
      throw new TokenStatsRepositoryError('invalid persisted token stats row');
    }
  }

  return value as StoredAggregateRow;
}

function buildEmptyAuthorityBreakdown(): AuthorityBreakdownDto {
  return {
    input: { official: 0, local: 0, heuristic: 0, partial: 0, none: 0 },
    output: { official: 0, local: 0, heuristic: 0, partial: 0, none: 0 },
  };
}

function getAuthorityFieldName(prefix: 'input' | 'output', authority: TokenAccountingAuthority): keyof StoredAggregateRow {
  const capitalized = authority.charAt(0).toUpperCase() + authority.slice(1);
  return `${prefix}Authority${capitalized}` as keyof StoredAggregateRow;
}

function getUtcHourBucket(isoTime: string): string {
  return new Date(isoTime).toISOString().slice(0, 13);
}

function parseGroupKey(key: string): { groupBy: GroupByDimension; dimension: string; bucket: string } | null {
  if (!key.startsWith(STORAGE_NAMESPACE)) return null;

  const remainder = key.slice(STORAGE_NAMESPACE.length);
  const firstSeparator = remainder.indexOf(':');
  const lastSeparator = remainder.lastIndexOf(':');
  if (firstSeparator <= 0 || lastSeparator <= firstSeparator) return null;

  const groupBy = remainder.slice(0, firstSeparator) as GroupByDimension;
  if (!['all', 'route', 'upstream', 'provider'].includes(groupBy)) return null;

  let dimension: string;
  try {
    dimension = decodeURIComponent(remainder.slice(firstSeparator + 1, lastSeparator));
  } catch {
    throw new TokenStatsRepositoryError('invalid persisted token stats key');
  }
  if (textEncoder.encode(dimension).byteLength > MAX_DIMENSION_BYTES) {
    throw new TokenStatsRepositoryLimitError('token stats dimension limit exceeded');
  }
  const bucket = remainder.slice(lastSeparator + 1);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}$/.test(bucket)) throw new TokenStatsRepositoryError('invalid persisted token stats key');
  return { groupBy, dimension, bucket };
}

function createStorageKey(groupBy: GroupByDimension, dimension: string, bucket: string): string {
  return `${STORAGE_NAMESPACE}${groupBy}:${encodeURIComponent(dimension)}:${bucket}`;
}

export function getCutoffTime(range: string): number {
  const normalizedRange = range === '1h' || range === '12h' || range === '24h' ? range : '24h';
  const now = Date.now();
  switch (normalizedRange as RangeKey) {
    case '1h': return now - 60 * 60 * 1000;
    case '12h': return now - 12 * 60 * 60 * 1000;
    case '24h': default: return now - 24 * 60 * 60 * 1000;
  }
}

export class TokenStatsRepository {
  constructor(private readonly storage: PluginStorage) {}

  async recordRequest(state: TokenStatsRecordState, finalEvents: CanonicalEvent[]): Promise<void> {
    const bucket = getUtcHourBucket(finalEvents[0]?.countedAt ?? new Date().toISOString());
    const increments = new Map<string, Partial<Record<keyof StoredAggregateRow, number>>>();

    const applyIncrement = (key: string, field: keyof StoredAggregateRow, amount: number) => {
      if (!amount) return;
      const current = increments.get(key) ?? {};
      current[field] = (current[field] ?? 0) + amount;
      increments.set(key, current);
    };

    const markLogicalRequest = (groupBy: GroupByDimension, dimension: string) => {
      applyIncrement(createStorageKey(groupBy, dimension, bucket), 'logicalRequests', 1);
    };

    const touchedUpstreams = state.touchedUpstreams.size > 0
      ? state.touchedUpstreams
      : new Set(finalEvents.map((event) => event.upstreamId));
    const touchedProviders = state.touchedProviders.size > 0
      ? state.touchedProviders
      : new Set(finalEvents.map((event) => event.provider));

    markLogicalRequest('all', 'all');
    markLogicalRequest('route', state.routeId || 'unknown');
    for (const upstreamId of touchedUpstreams) markLogicalRequest('upstream', upstreamId || 'unknown');
    for (const provider of touchedProviders) markLogicalRequest('provider', provider || 'unknown');

    applyIncrement(createStorageKey('all', 'all', bucket), 'upstreamAttempts', state.attemptsStarted);
    applyIncrement(createStorageKey('route', state.routeId || 'unknown', bucket), 'upstreamAttempts', state.attemptsStarted);

    for (const upstreamId of touchedUpstreams) {
      const attempts = Array.from(state.attempts.values()).filter((attempt) => attempt.upstreamId === upstreamId).length;
      applyIncrement(createStorageKey('upstream', upstreamId || 'unknown', bucket), 'upstreamAttempts', attempts);
    }
    for (const provider of touchedProviders) {
      const attempts = Array.from(state.attempts.values()).filter((attempt) => attempt.provider === provider).length;
      applyIncrement(createStorageKey('provider', provider || 'unknown', bucket), 'upstreamAttempts', attempts);
    }

    for (const event of finalEvents) {
      const dimensions: Array<[GroupByDimension, string]> = [
        ['all', 'all'],
        ['route', event.routeId || state.routeId || 'unknown'],
        ['upstream', event.upstreamId || 'unknown'],
        ['provider', event.provider || 'unknown'],
      ];
      for (const [groupBy, dimension] of dimensions) {
        const key = createStorageKey(groupBy, dimension, bucket);
        applyIncrement(key, 'inputTokens', event.inputTokens ?? 0);
        applyIncrement(key, 'outputTokens', event.outputTokens ?? 0);
        applyIncrement(key, 'officialInputTokens', event.inputAuthority === 'official' ? (event.inputTokens ?? 0) : 0);
        applyIncrement(key, 'officialOutputTokens', event.outputAuthority === 'official' ? (event.outputTokens ?? 0) : 0);
        applyIncrement(key, 'partialOutputs', event.outputAuthority === 'partial' ? 1 : 0);
        applyIncrement(key, getAuthorityFieldName('input', event.inputAuthority), 1);
        applyIncrement(key, getAuthorityFieldName('output', event.outputAuthority), 1);
      }
    }

    const operations: Array<Promise<unknown>> = [];
    for (const [key, fields] of increments.entries()) {
      for (const [field, amount] of Object.entries(fields)) {
        if (amount) operations.push(this.storage.increment(key, field, amount));
      }
    }
    await Promise.all(operations);
  }

  async query(range: string, groupBy: GroupByDimension): Promise<AggregateDto> {
    const cutoff = getCutoffTime(range);
    const rows = await this.readRows(groupBy, cutoff);
    const totalRow = groupBy === 'all'
      ? rows.get('all') ?? {}
      : (await this.readRows('all', cutoff)).get('all') ?? {};

    return {
      groupBy,
      totalInputTokens: toNumber(totalRow.inputTokens),
      totalOutputTokens: toNumber(totalRow.outputTokens),
      logicalRequests: toNumber(totalRow.logicalRequests),
      upstreamAttempts: toNumber(totalRow.upstreamAttempts),
      authorityBreakdown: this.toAuthorityBreakdown(totalRow),
      data: groupBy === 'all'
        ? []
        : Array.from(rows.entries()).map(([dimension, row]) => this.toGroupedDto(dimension, row)).sort((a, b) => {
          if (b.inputTokens + b.outputTokens !== a.inputTokens + a.outputTokens) {
            return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
          }
          return b.upstreamAttempts - a.upstreamAttempts;
        }),
    };
  }

  private async readRows(groupBy: GroupByDimension, cutoff: number): Promise<Map<string, StoredAggregateRow>> {
    const keys = await this.storage.keys(`${STORAGE_NAMESPACE}${groupBy}:`);
    if (keys.length > MAX_STORAGE_ENTRIES) {
      throw new TokenStatsRepositoryLimitError('token stats entry limit exceeded');
    }
    const rows = new Map<string, StoredAggregateRow>();
    for (const key of keys) {
      if (typeof key !== 'string') throw new TokenStatsRepositoryError('invalid persisted token stats key');
      if (textEncoder.encode(key).byteLength > MAX_STORAGE_KEY_BYTES) {
        throw new TokenStatsRepositoryLimitError('token stats key limit exceeded');
      }
      const parsed = parseGroupKey(key);
      if (!parsed || parsed.groupBy !== groupBy) continue;
      const bucketTime = new Date(`${parsed.bucket}:00:00.000Z`).getTime();
      if (!Number.isFinite(bucketTime) || bucketTime < cutoff) continue;
      const stored = await this.storage.get<StoredAggregateRow>(key);
      if (stored === null) throw new TokenStatsRepositoryError('invalid persisted token stats row');
      let serialized: string | undefined;
      try { serialized = JSON.stringify(stored); } catch { serialized = undefined; }
      if (serialized === undefined || textEncoder.encode(serialized).byteLength > MAX_STORAGE_ROW_BYTES) {
        throw new TokenStatsRepositoryLimitError('token stats row limit exceeded');
      }
      const current = rows.get(parsed.dimension) ?? {};
      rows.set(parsed.dimension, this.mergeRow(current, readStoredRow(stored)));
    }
    return rows;
  }

  private mergeRow(left: StoredAggregateRow, right: StoredAggregateRow): StoredAggregateRow {
    const merged: StoredAggregateRow = {};
    for (const key of ROW_FIELDS) merged[key] = toNumber(left[key]) + toNumber(right[key]);
    return merged;
  }

  private toAuthorityBreakdown(row: StoredAggregateRow): AuthorityBreakdownDto {
    const breakdown = buildEmptyAuthorityBreakdown();
    for (const authority of TOKEN_ACCOUNTING_AUTHORITIES) {
      breakdown.input[authority] = toNumber(row[getAuthorityFieldName('input', authority)]);
      breakdown.output[authority] = toNumber(row[getAuthorityFieldName('output', authority)]);
    }
    return breakdown;
  }

  private toGroupedDto(dimension: string, row: StoredAggregateRow): GroupedAggregateDto {
    return {
      dimension,
      inputTokens: toNumber(row.inputTokens),
      outputTokens: toNumber(row.outputTokens),
      logicalRequests: toNumber(row.logicalRequests),
      upstreamAttempts: toNumber(row.upstreamAttempts),
      officialInputTokens: toNumber(row.officialInputTokens),
      officialOutputTokens: toNumber(row.officialOutputTokens),
      partialOutputs: toNumber(row.partialOutputs),
      authorityBreakdown: this.toAuthorityBreakdown(row),
    };
  }
}
