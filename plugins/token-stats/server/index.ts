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
  assertCanonicalTokenAccountingEventV2,
  createTokenAccountingSession,
} from '@jeffusion/bungee-llms/plugin-api';
import { TokenStatsRepository, type CanonicalEvent } from './repository';

type JsonRecord = Record<string, unknown>;
type SupportedProvider = 'openai' | 'anthropic' | 'gemini';

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

const requestStateMap = new Map<string, RequestState>();
let lastCleanupTime = Date.now();

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

    async onDestroy(): Promise<void> {
      this.logger.info('TokenStatsPlugin destroyed');
    }
  }
);

export default TokenStatsPlugin;
