import type { PluginStorage, Plugin, TokenStatsAttempt } from '../../../packages/core/src/plugin.types';
import { definePlugin } from '../../../packages/core/src/plugin.types';
import type { AttemptObservationEvent, PluginHooks, PluginInitContext, PluginLogger } from '../../../packages/core/src/hooks';
import { assertCanonicalTokenAccountingEventV2, createTokenAccountingSession } from '@jeffusion/bungee-llms/plugin-api';
import { TokenStatsRepository, attemptRowFromEvent, type CanonicalEvent } from './repository';
import { directPricingProviderFromUrl, TokenStatsPricing, type DirectPricingProvider } from './pricing';
import { classifyRequest, classifyResponse, type SupportedProvider } from './classifier';

type JsonRecord = Record<string, unknown>;
type TokenAccountingSession = ReturnType<typeof createTokenAccountingSession>;

interface AttemptState {
  attemptId: string;
  requestId: string;
  routeId: string;
  upstreamId: string;
  provider: SupportedProvider | 'unknown';
  pricingProvider?: DirectPricingProvider;
  model?: string;
  sent: boolean;
  llm: boolean;
  streaming: boolean;
  session?: TokenAccountingSession;
  responseSeen: boolean;
  responseFailed: boolean;
  observationIncomplete: boolean;
  incompleteReasonLogged: boolean;
  latestEvent?: CanonicalEvent;
}

const MAX_ACTIVE_ATTEMPTS = 1024;
const MAX_REQUEST_BODY_CHARS = 1024 * 1024;
const LOG_INTERVAL_MS = 60_000;
const attempts = new Map<string, AttemptState>();
let lastCapacityWarningAt = 0;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequestBody(value: unknown): JsonRecord | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_REQUEST_BODY_CHARS) return undefined;
  try {
    const body: unknown = JSON.parse(value);
    return isRecord(body) ? body : undefined;
  } catch { return undefined; }
}

function detectModel(body: JsonRecord, url?: URL): string | undefined {
  if (typeof body.model === 'string' && body.model.length > 0) return body.model;
  const match = url?.pathname.match(/\/models\/([^/:]+):(?:stream)?generatecontent/i);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return match[1]; }
}

function createAttempt(event: AttemptObservationEvent): AttemptState {
  return {
    attemptId: event.attemptId,
    requestId: event.requestId,
    routeId: event.routeId || 'unknown',
    upstreamId: event.upstreamId || 'unknown',
    provider: 'unknown', sent: false, llm: false, streaming: false, responseSeen: false, responseFailed: false,
    observationIncomplete: false, incompleteReasonLogged: false,
  };
}

function getAttempt(event: AttemptObservationEvent, logger: PluginLogger): AttemptState {
  let attempt = attempts.get(event.attemptId);
  if (!attempt) {
    if (attempts.size >= MAX_ACTIVE_ATTEMPTS) {
      const oldest = attempts.keys().next().value as string | undefined;
      if (oldest !== undefined) attempts.delete(oldest);
      const now = Date.now();
      if (now - lastCapacityWarningAt >= LOG_INTERVAL_MS) {
        lastCapacityWarningAt = now;
        logger.warn('Token stats active attempt state capacity reached; oldest state dropped', { capacity: MAX_ACTIVE_ATTEMPTS });
      }
    }
    attempt = createAttempt(event);
    attempts.set(event.attemptId, attempt);
  }
  attempt.routeId = event.routeId || attempt.routeId;
  attempt.upstreamId = event.upstreamId || attempt.upstreamId;
  return attempt;
}

function ensureSession(attempt: AttemptState, provider: SupportedProvider): void {
  if (attempt.session) return;
  attempt.provider = provider;
  attempt.session = createTokenAccountingSession({
    provider,
    model: attempt.model,
    routeId: attempt.routeId,
    upstreamId: attempt.upstreamId,
    requestId: attempt.requestId,
    attemptId: attempt.attemptId,
    streaming: attempt.streaming,
  }, { deferFinalization: true });
}

function markSent(attempt: AttemptState): void { attempt.sent = true; }

function mergeOfficialUsage(current: CanonicalEvent, previous?: CanonicalEvent): CanonicalEvent {
  if (!previous) return current;
  if (current.inputAuthority !== 'official' && previous.inputAuthority === 'official' && previous.inputTokens !== undefined) {
    current.inputTokens = previous.inputTokens;
    current.inputAuthority = 'official';
  }
  if (current.outputAuthority !== 'official' && previous.outputAuthority === 'official' && previous.outputTokens !== undefined) {
    current.outputTokens = previous.outputTokens;
    current.outputAuthority = 'official';
  }
  current.cacheReadTokens = mergeObservedCount(current.cacheReadTokens, previous.cacheReadTokens);
  current.cacheWriteTokens = mergeObservedCount(current.cacheWriteTokens, previous.cacheWriteTokens);
  return current;
}

function mergeObservedCount(current?: number, previous?: number): number | undefined {
  if (current === undefined) return previous;
  if (previous === undefined) return current;
  return Math.max(current, previous);
}

function officialOnly(event: CanonicalEvent): CanonicalEvent | undefined {
  const input = event.inputAuthority === 'official' && event.inputTokens !== undefined;
  const output = event.outputAuthority === 'official' && event.outputTokens !== undefined;
  if (!input && !output) return undefined;
  if (!input) { event.inputTokens = undefined; event.inputAuthority = 'none'; }
  if (!output) { event.outputTokens = undefined; event.outputAuthority = 'none'; }
  return event;
}

type EndOutcome = 'completed' | 'failed' | 'cancelled';

interface FinalizationTaskInput {
  attemptId: string;
  requestId: string;
  routeId: string;
  upstreamId: string;
  provider: string;
  session?: TokenAccountingSession;
  observedEvent?: CanonicalEvent;
  finishedAtMs: number;
  endOutcome: EndOutcome;
  responseSeen: boolean;
  responseFailed: boolean;
  observationIncomplete: boolean;
  model?: string;
  pricingProvider?: DirectPricingProvider;
  pricing: TokenStatsPricing;
}

function finalOutcome(input: FinalizationTaskInput, canonicalOutcome?: CanonicalEvent['outcome']): 'completed' | 'failed' | 'aborted' {
  if (input.endOutcome === 'cancelled') return 'aborted';
  if (input.endOutcome === 'failed' || !input.responseSeen || input.responseFailed || input.observationIncomplete || canonicalOutcome === 'failed') return 'failed';
  if (canonicalOutcome === 'aborted') return 'aborted';
  return 'completed';
}

function unknownAttemptRow(input: FinalizationTaskInput): TokenStatsAttempt {
  return {
    attempt_id: input.attemptId, request_id: input.requestId, finished_at_ms: input.finishedAtMs,
    route_id: input.routeId || 'unknown', upstream_id: input.upstreamId || 'unknown',
    provider: input.provider, outcome: finalOutcome(input), model: input.model || 'unknown', input_tokens: null, output_tokens: null,
    input_source: 'unknown', output_source: 'unknown', cache_read_tokens: null, cache_write_tokens: null,
    cost_usd: null,
    observation_incomplete: input.observationIncomplete,
  };
}

function createFinalizationTask(input: FinalizationTaskInput): () => Promise<TokenStatsAttempt> {
  return async () => {
    await input.pricing.ready().catch(() => {});
    if (!input.session) return unknownAttemptRow(input);

    let finalized: CanonicalEvent | undefined;
    try {
      finalized = input.endOutcome === 'completed' && input.responseSeen && !input.responseFailed && !input.observationIncomplete
        ? input.session.finalizeCompletedStream()
        : input.session.finalizeAbortedStream();
    } catch {
      // Preserve observations already validated during the nonblocking callback.
    }

    let event = input.observedEvent;
    if (finalized) {
      assertCanonicalTokenAccountingEventV2(finalized);
      event = mergeOfficialUsage(finalized, input.observedEvent);
    }
    if (!event) return unknownAttemptRow(input);

    const outcome = finalOutcome(input, event.outcome);
    event = { ...event, outcome, final: outcome === 'completed' };
    if (outcome !== 'completed' && !officialOnly(event)) {
      event.inputTokens = undefined;
      event.inputAuthority = 'none';
      event.outputTokens = undefined;
      event.outputAuthority = 'none';
    }
    assertCanonicalTokenAccountingEventV2(event);
    const row = attemptRowFromEvent(event, input.finishedAtMs, input.observationIncomplete, input.model || 'unknown');
    return {
      ...row,
      cost_usd: input.pricing.estimate({
        model: input.model,
        provider: input.pricingProvider,
        inputTokens: row.input_tokens ?? undefined,
        outputTokens: row.output_tokens ?? undefined,
        cacheReadTokens: row.cache_read_tokens ?? undefined,
        cacheWriteTokens: row.cache_write_tokens ?? undefined,
      }),
    };
  };
}

export const TokenStatsPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'token-stats';
    static readonly version = '3.2.0';

    storage!: PluginStorage;
    logger!: PluginLogger;
    repository!: TokenStatsRepository;
    pricing!: TokenStatsPricing;

    constructor(_config: Record<string, unknown> = {}, private readonly pricingFactory?: () => TokenStatsPricing) {}

    async init(context: PluginInitContext): Promise<void> {
      this.storage = context.storage;
      this.logger = context.logger;
      this.repository = new TokenStatsRepository(context.storage);
      this.pricing = this.pricingFactory?.() ?? new TokenStatsPricing({ storage: context.storage });
      this.pricing.start();
      this.logger.info('TokenStatsPlugin initialized');
    }

    register(hooks: PluginHooks): void {
      hooks.onAttemptObservation.tapPromise({ name: 'token-stats' }, async (event) => this.handleAttemptObservation(event));
    }

    private async handleAttemptObservation(event: AttemptObservationEvent): Promise<void> {
      if (!event.isActive()) {
        attempts.delete(event.attemptId);
        return;
      }
      if (event.phase === 'request-end') return;
      if (event.phase === 'selected') {
        getAttempt(event, this.logger);
        return;
      }
      const attempt = event.phase === 'end'
        ? attempts.get(event.attemptId)
        : getAttempt(event, this.logger);
      if (!attempt) return;

      if (event.phase === 'request') {
        markSent(attempt);
        if (attempt.session) return;
        let url: URL;
        try { url = new URL(event.url, 'http://token-stats-observation.invalid'); }
        catch { return; }
        attempt.pricingProvider = directPricingProviderFromUrl(url);
        const body = parseRequestBody(event.body);
        if (!body) return;
        const classification = classifyRequest(url, body);
        attempt.llm ||= classification.llm;
        if (!classification.llm) return;
        attempt.model = detectModel(body, url) ?? attempt.model;
        const provider = classification.provider;
        if (!provider) return;
        attempt.streaming = body.stream === true || /:streamgeneratecontent/i.test(url.pathname);
        ensureSession(attempt, provider);
        attempt.session!.consumeRequest({ body });
        return;
      }

      if (event.phase === 'response') {
        attempt.responseSeen = true;
        const body = event.body;
        attempt.responseFailed ||= event.status >= 400 || body.error !== undefined;
        const provider = attempt.provider === 'unknown' ? classifyResponse(body, attempt.llm) : attempt.provider;
        if (!provider) return;
        if (!attempt.llm) {
          attempt.model = detectModel(body) ?? (isRecord(body.response) ? detectModel(body.response) : undefined);
        }
        attempt.llm = true;
        if (!attempt.session) {
          attempt.streaming = event.protocol === 'sse';
          ensureSession(attempt, provider);
          // The request payload is intentionally not retained for ambiguous protocols.
        }
        const session = attempt.session;
        if (!session) return;
        try {
          const parsed = event.protocol === 'json'
            ? session.consumeResponse({ body })
            : session.consumeStreamChunk({ chunk: body });
          if (!parsed) return;
          assertCanonicalTokenAccountingEventV2(parsed);
          const merged = mergeOfficialUsage(parsed, attempt.latestEvent);
          attempt.latestEvent = attempt.responseFailed ? officialOnly(merged) : merged;
        } catch (error) {
          attempt.observationIncomplete = true;
          if (attempt.latestEvent) attempt.latestEvent = officialOnly(attempt.latestEvent);
          this.logger.debug('Failed to consume token stats attempt observation', { attemptId: event.attemptId, error });
        }
        return;
      }

      if (event.phase === 'incomplete') {
        if (!attempt.observationIncomplete) {
          attempt.observationIncomplete = true;
          if (!attempt.incompleteReasonLogged) {
            attempt.incompleteReasonLogged = true;
            this.logger.warn('Token stats attempt observation incomplete', { attemptId: event.attemptId, reason: event.reason });
          }
          if (attempt.latestEvent) attempt.latestEvent = officialOnly(attempt.latestEvent);
        }
        return;
      }

      if (event.phase === 'end') {
        if (event.sent) markSent(attempt);
        if (!event.isActive()) {
          attempts.delete(event.attemptId);
          return;
        }
        attempts.delete(event.attemptId);
        if (!attempt.sent || !attempt.llm) return;
        const taskInput: FinalizationTaskInput = {
          attemptId: attempt.attemptId,
          requestId: attempt.requestId,
          routeId: attempt.routeId,
          upstreamId: attempt.upstreamId,
          provider: attempt.provider,
          model: attempt.model,
          pricingProvider: attempt.pricingProvider,
          pricing: this.pricing,
          session: attempt.session,
          observedEvent: attempt.latestEvent ? { ...attempt.latestEvent } : undefined,
          finishedAtMs: Date.now(),
          endOutcome: event.outcome,
          responseSeen: attempt.responseSeen,
          responseFailed: attempt.responseFailed,
          observationIncomplete: attempt.observationIncomplete,
        };
        this.repository.enqueueAttempt(createFinalizationTask(taskInput), this.logger);
      }
    }

    async onDestroy(): Promise<void> {
      this.pricing?.stop();
      this.logger.info('TokenStatsPlugin destroyed');
    }
  }
);

export default TokenStatsPlugin;
