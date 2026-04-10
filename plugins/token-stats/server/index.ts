import type {
  PluginStorage,
  Plugin,
} from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type {
  PluginHooks,
  PluginInitContext,
  PluginLogger,
  MutableRequestContext,
  RequestContext,
  ResponseContext,
  StreamChunkContext,
  FinallyContext,
} from '../../../packages/core/src/hooks';
import {
  TOKEN_ACCOUNTING_AUTHORITIES,
  assertCanonicalTokenAccountingEventV2,
  type CanonicalTokenAccountingEventV2,
  createTokenAccountingSession,
} from '@jeffusion/bungee-llms/plugin-api';

type JsonRecord = Record<string, unknown>;
type TokenAccountingAuthority = typeof TOKEN_ACCOUNTING_AUTHORITIES[number];
type SupportedProvider = 'openai' | 'anthropic' | 'gemini';
type GroupByDimension = 'all' | 'route' | 'upstream' | 'provider';
type RangeKey = '1h' | '12h' | '24h';

const STORAGE_NAMESPACE = 'token-stats:v2:';
const REQUEST_STATE_TTL_MS = 10 * 60 * 1000;
const STATE_KEYS = {
  ATTEMPT_ID: 'token-stats:v2:attempt-id',
} as const;

interface AttemptState {
  attemptId: string;
  requestId: string;
  routeId: string;
  upstreamId: string;
  provider: SupportedProvider;
  streaming: boolean;
  session: ReturnType<typeof createTokenAccountingSession>;
  latestEvent?: CanonicalEvent;
  finalized: boolean;
}

interface RequestState {
  requestId: string;
  routeId: string;
  attemptsStarted: number;
  attempts: Map<string, AttemptState>;
  touchedUpstreams: Set<string>;
  touchedProviders: Set<string>;
  updatedAt: number;
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

interface AggregateDto {
  groupBy: GroupByDimension;
  totalInputTokens: number;
  totalOutputTokens: number;
  logicalRequests: number;
  upstreamAttempts: number;
  authorityBreakdown: AuthorityBreakdownDto;
  data: GroupedAggregateDto[];
}

interface GroupedAggregateDto {
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

interface AuthorityBreakdownDto {
  input: Record<TokenAccountingAuthority, number>;
  output: Record<TokenAccountingAuthority, number>;
}

type CanonicalEvent = Parameters<typeof assertCanonicalTokenAccountingEventV2>[0] extends never
  ? never
  : CanonicalTokenAccountingEventV2;

const requestStateMap = new Map<string, RequestState>();
let lastCleanupTime = Date.now();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function buildEmptyAuthorityBreakdown(): AuthorityBreakdownDto {
  return {
    input: {
      official: 0,
      local: 0,
      heuristic: 0,
      partial: 0,
      none: 0,
    },
    output: {
      official: 0,
      local: 0,
      heuristic: 0,
      partial: 0,
      none: 0,
    },
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
  if (!key.startsWith(STORAGE_NAMESPACE)) {
    return null;
  }

  const remainder = key.slice(STORAGE_NAMESPACE.length);
  const firstSeparator = remainder.indexOf(':');
  const lastSeparator = remainder.lastIndexOf(':');
  if (firstSeparator <= 0 || lastSeparator <= firstSeparator) {
    return null;
  }

  const groupBy = remainder.slice(0, firstSeparator) as GroupByDimension;
  if (!['all', 'route', 'upstream', 'provider'].includes(groupBy)) {
    return null;
  }

  const dimension = decodeURIComponent(remainder.slice(firstSeparator + 1, lastSeparator));
  const bucket = remainder.slice(lastSeparator + 1);
  return { groupBy, dimension, bucket };
}

function createStorageKey(groupBy: GroupByDimension, dimension: string, bucket: string): string {
  return `${STORAGE_NAMESPACE}${groupBy}:${encodeURIComponent(dimension)}:${bucket}`;
}

function getCutoffTime(range: string): number {
  const normalizedRange = range === '1h' || range === '12h' || range === '24h' ? range : '24h';
  const now = Date.now();
  switch (normalizedRange as RangeKey) {
    case '1h':
      return now - 60 * 60 * 1000;
    case '12h':
      return now - 12 * 60 * 60 * 1000;
    case '24h':
    default:
      return now - 24 * 60 * 60 * 1000;
  }
}

function detectProviderFromUrl(url: URL): SupportedProvider | null {
  const pathname = url.pathname.toLowerCase();
  if (pathname.includes('/messages')) {
    return 'anthropic';
  }

  if (pathname.includes('/chat/completions') || pathname.includes('/responses') || pathname.includes('/completions')) {
    return 'openai';
  }

  if (pathname.includes(':generatecontent') || pathname.includes(':streamgeneratecontent')) {
    return 'gemini';
  }

  return null;
}

function detectProviderFromBody(body: JsonRecord): SupportedProvider | null {
  if (Array.isArray(body.contents) || isRecord(body.generationConfig) || isRecord(body.systemInstruction)) {
    return 'gemini';
  }

  if (typeof body.anthropic_version === 'string' || typeof body.max_tokens === 'number' || typeof body.max_tokens_to_sample === 'number') {
    return 'anthropic';
  }

  if (Array.isArray(body.messages) || Array.isArray(body.input)) {
    return 'openai';
  }

  return null;
}

function detectProvider(body: JsonRecord, url: URL): SupportedProvider {
  return detectProviderFromUrl(url) ?? detectProviderFromBody(body) ?? 'openai';
}

function cleanupExpiredStates(): void {
  const now = Date.now();
  if (now - lastCleanupTime < 60_000) {
    return;
  }

  lastCleanupTime = now;
  for (const [requestId, state] of requestStateMap.entries()) {
    if (now - state.updatedAt > REQUEST_STATE_TTL_MS) {
      requestStateMap.delete(requestId);
    }
  }
}

function getOrCreateRequestState(ctx: RequestContext): RequestState {
  const existing = requestStateMap.get(ctx.requestId);
  if (existing) {
    existing.updatedAt = Date.now();
    existing.routeId = ctx.routeId || existing.routeId;
    return existing;
  }

  const created: RequestState = {
    requestId: ctx.requestId,
    routeId: ctx.routeId || 'unknown',
    attemptsStarted: 0,
    attempts: new Map(),
    touchedUpstreams: new Set(),
    touchedProviders: new Set(),
    updatedAt: Date.now(),
  };
  requestStateMap.set(ctx.requestId, created);
  return created;
}

function getAttemptState(ctx: RequestContext & { streamState?: Map<string, any> }): AttemptState | null {
  const requestState = requestStateMap.get(ctx.requestId);
  if (!requestState) {
    return null;
  }

  const attemptId = ctx.streamState?.get(STATE_KEYS.ATTEMPT_ID) as string | undefined;
  if (attemptId) {
    return requestState.attempts.get(attemptId) ?? null;
  }

  const attempts = Array.from(requestState.attempts.values());
  return attempts[attempts.length - 1] ?? null;
}

class TokenStatsRepository {
  constructor(
    private readonly storage: PluginStorage,
  ) {}

  async recordRequest(state: RequestState, finalEvents: CanonicalEvent[]): Promise<void> {
    const bucket = getUtcHourBucket(finalEvents[0]?.countedAt ?? new Date().toISOString());
    const increments = new Map<string, Partial<Record<keyof StoredAggregateRow, number>>>();

    const applyIncrement = (key: string, field: keyof StoredAggregateRow, amount: number) => {
      if (!amount) {
        return;
      }

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
    for (const upstreamId of touchedUpstreams) {
      markLogicalRequest('upstream', upstreamId || 'unknown');
    }
    for (const provider of touchedProviders) {
      markLogicalRequest('provider', provider || 'unknown');
    }

    applyIncrement(createStorageKey('all', 'all', bucket), 'upstreamAttempts', state.attemptsStarted);
    applyIncrement(createStorageKey('route', state.routeId || 'unknown', bucket), 'upstreamAttempts', state.attemptsStarted);

    for (const upstreamId of touchedUpstreams) {
      const attemptsForUpstream = Array.from(state.attempts.values()).filter((attempt) => attempt.upstreamId === upstreamId).length;
      applyIncrement(createStorageKey('upstream', upstreamId || 'unknown', bucket), 'upstreamAttempts', attemptsForUpstream);
    }

    for (const provider of touchedProviders) {
      const attemptsForProvider = Array.from(state.attempts.values()).filter((attempt) => attempt.provider === provider).length;
      applyIncrement(createStorageKey('provider', provider || 'unknown', bucket), 'upstreamAttempts', attemptsForProvider);
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
        if (!amount) {
          continue;
        }

        operations.push(this.storage.increment(key, field, amount));
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
        : Array.from(rows.entries())
          .map(([dimension, row]) => this.toGroupedDto(dimension, row))
          .sort((a, b) => {
            if (b.inputTokens + b.outputTokens !== a.inputTokens + a.outputTokens) {
              return b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
            }
            return b.upstreamAttempts - a.upstreamAttempts;
          }),
    };
  }

  private async readRows(groupBy: GroupByDimension, cutoff: number): Promise<Map<string, StoredAggregateRow>> {
    const keys = await this.storage.keys(`${STORAGE_NAMESPACE}${groupBy}:`);
    const rows = new Map<string, StoredAggregateRow>();

    for (const key of keys) {
      const parsed = parseGroupKey(key);
      if (!parsed || parsed.groupBy !== groupBy) {
        continue;
      }

      const bucketTime = new Date(`${parsed.bucket}:00:00.000Z`).getTime();
      if (!Number.isFinite(bucketTime) || bucketTime < cutoff) {
        continue;
      }

      const stored = await this.storage.get<StoredAggregateRow>(key);
      if (!stored) {
        continue;
      }

      const current = rows.get(parsed.dimension) ?? {};
      rows.set(parsed.dimension, this.mergeRow(current, stored));
    }

    return rows;
  }

  private mergeRow(left: StoredAggregateRow, right: StoredAggregateRow): StoredAggregateRow {
    const merged: StoredAggregateRow = {};
    for (const key of [
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
    ] as const) {
      merged[key] = toNumber(left[key]) + toNumber(right[key]);
    }
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

export const TokenStatsPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'token-stats';
    static readonly version = '2.0.0';

    storage!: PluginStorage;
    logger!: PluginLogger;
    repository!: TokenStatsRepository;

    async init(context: PluginInitContext): Promise<void> {
      this.storage = context.storage;
      this.logger = context.logger;
      this.repository = new TokenStatsRepository(context.storage);
      this.logger.info('TokenStatsPlugin v2 initialized');
    }

    register(hooks: PluginHooks): void {
      hooks.onRequestInit.tapPromise(
        { name: 'token-stats', stage: 0 },
        async (ctx) => {
          cleanupExpiredStates();
          getOrCreateRequestState(ctx);
        }
      );

      hooks.onBeforeRequest.tapPromise(
        { name: 'token-stats', stage: 10 },
        async (ctx) => {
          await this.handleAttemptStart(ctx);
          return ctx;
        }
      );

      hooks.onResponse.tapPromise(
        { name: 'token-stats', stage: -10 },
        async (response, ctx) => {
          await this.handleResponse(response, ctx);
          return response;
        }
      );

      hooks.onStreamChunk.tapPromise(
        { name: 'token-stats', stage: -10 },
        async (chunk, ctx) => {
          await this.handleStreamChunk(chunk, ctx);
          return null;
        }
      );

      hooks.onFinally.tapPromise(
        { name: 'token-stats', stage: 0 },
        async (ctx) => {
          await this.handleFinally(ctx);
        }
      );
    }

    async handleAttemptStart(ctx: MutableRequestContext): Promise<void> {
      if (!isRecord(ctx.body)) {
        return;
      }

      const state = getOrCreateRequestState(ctx);
      state.updatedAt = Date.now();
      state.routeId = ctx.routeId || state.routeId;
      state.attemptsStarted += 1;

      const provider = detectProvider(ctx.body, ctx.url);
      const attemptId = `${ctx.requestId}:attempt:${state.attemptsStarted}`;
      const streaming = Boolean(ctx.body.stream);
      const session = createTokenAccountingSession({
        provider,
        model: typeof ctx.body.model === 'string' ? ctx.body.model : undefined,
        routeId: ctx.routeId || 'unknown',
        upstreamId: ctx.upstreamId || 'unknown',
        requestId: ctx.requestId,
        attemptId,
        streaming,
      });

      session.consumeRequest({ body: ctx.body });

      const attempt: AttemptState = {
        attemptId,
        requestId: ctx.requestId,
        routeId: ctx.routeId || 'unknown',
        upstreamId: ctx.upstreamId || 'unknown',
        provider,
        streaming,
        session,
        finalized: false,
      };

      state.attempts.set(attemptId, attempt);
      state.touchedUpstreams.add(attempt.upstreamId);
      state.touchedProviders.add(attempt.provider);
      this.logger.debug('Token stats attempt started', {
        requestId: ctx.requestId,
        attemptId,
        routeId: attempt.routeId,
        upstreamId: attempt.upstreamId,
        provider,
        streaming,
      });
    }

    async handleResponse(response: Response, ctx: ResponseContext): Promise<void> {
      const attempt = getAttemptState(ctx);
      if (!attempt) {
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        return;
      }

      try {
        const body = await response.clone().json();
        if (!isRecord(body)) {
          return;
        }

        const event = attempt.session.consumeResponse({ body });
        assertCanonicalTokenAccountingEventV2(event);
        attempt.latestEvent = event;
        attempt.finalized = true;
      } catch (error) {
        this.logger.debug('Failed to consume token stats response event', {
          requestId: ctx.requestId,
          error,
        });
      }
    }

    async handleStreamChunk(chunk: any, ctx: StreamChunkContext): Promise<void> {
      const attempt = getAttemptState(ctx);
      if (!attempt || !isRecord(chunk)) {
        return;
      }

      ctx.streamState.set(STATE_KEYS.ATTEMPT_ID, attempt.attemptId);

      try {
        const event = attempt.session.consumeStreamChunk({ chunk });
        if (!event) {
          return;
        }

        assertCanonicalTokenAccountingEventV2(event);
        attempt.latestEvent = event;
        if (event.final || event.outcome !== 'completed') {
          attempt.finalized = true;
        }
      } catch (error) {
        this.logger.debug('Failed to consume token stats stream event', {
          requestId: ctx.requestId,
          error,
        });
      }
    }

    async handleFinally(ctx: FinallyContext): Promise<void> {
      const state = requestStateMap.get(ctx.requestId);
      if (!state) {
        return;
      }

      state.updatedAt = Date.now();
      const finalEvents: CanonicalEvent[] = [];

      for (const attempt of state.attempts.values()) {
        if (attempt.finalized && attempt.latestEvent) {
          finalEvents.push(attempt.latestEvent);
          continue;
        }

        if (!attempt.streaming) {
          continue;
        }

        try {
          const abortedEvent = attempt.session.finalizeAbortedStream();
          assertCanonicalTokenAccountingEventV2(abortedEvent);
          attempt.latestEvent = abortedEvent;
          attempt.finalized = true;
          finalEvents.push(abortedEvent);
        } catch (error) {
          this.logger.debug('Failed to finalize aborted token stats stream attempt', {
            requestId: ctx.requestId,
            attemptId: attempt.attemptId,
            error,
          });
        }
      }

      try {
        await this.repository.recordRequest(state, finalEvents);
      } finally {
        requestStateMap.delete(ctx.requestId);
      }
    }

    async getStats(req: Request): Promise<Response> {
      try {
        const url = new URL(req.url);
        const range = url.searchParams.get('range') || '24h';
        const rawGroupBy = url.searchParams.get('groupBy') || 'all';
        const groupBy = ['all', 'route', 'upstream', 'provider'].includes(rawGroupBy)
          ? rawGroupBy as GroupByDimension
          : 'all';

        const payload = await this.repository.query(range, groupBy);
        return new Response(JSON.stringify(payload), {
          headers: { 'Content-Type': 'application/json' },
        });
      } catch (error: any) {
        this.logger.error('Failed to get token stats', { error });
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }

    async onDestroy(): Promise<void> {
      this.logger.info('TokenStatsPlugin destroyed');
    }
  }
);

export default TokenStatsPlugin;
