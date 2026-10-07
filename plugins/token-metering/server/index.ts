import type { Plugin } from '@jeffusion/bungee-core/plugin';
import { definePlugin } from '@jeffusion/bungee-core/plugin';
import type { AttemptObservationEvent, PluginHooks, PluginInitContext, PluginLogger } from '@jeffusion/bungee-core/plugin';
import { assertCanonicalTokenAccountingEventV2, createTokenAccountingSession } from '@jeffusion/bungee-llms/plugin-api';
import type { CanonicalTokenAccountingEventV2 as CanonicalEvent } from '@jeffusion/bungee-llms/plugin-api';
import { TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION, type TokenMeteringResult, type TokenMeteringService, type TokenMeteringSubscription } from '@jeffusion/bungee-core/plugin';

import { classifyRequest, classifyResponse, type SupportedProvider } from './classifier';

type JsonRecord = Record<string, unknown>;
type TokenAccountingSession = ReturnType<typeof createTokenAccountingSession>;

interface AttemptState {
  attemptId: string;
  requestId: string;
  keyId?: string | null;
  routeId: string;
  upstreamId: string;
  provider: SupportedProvider | 'unknown';
  pricingProvider?: string;
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
const LOG_INTERVAL_MS = 60_000;

let lastCapacityWarningAt = 0;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseRequestBody(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function detectModel(body: JsonRecord, url?: URL): string | undefined {
  if (typeof body.model === 'string' && body.model.length > 0) return body.model;
  const match = url?.pathname.match(/\/models\/([^/:]+):(?:stream)?generatecontent/i);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return match[1]; }
}

/**
 * The provable provider identity is the FULL original upstream URL (scheme + host
 * + path): the models.dev catalog's `provider.api` is matched by host AND path, so
 * a host-only hint would lose information. A relative/fixture URL carries no real
 * origin and therefore no provider identity.
 */
function pricingProviderFromUrl(url: URL): string | undefined {
  return url.origin === 'http://token-metering-observation.invalid' ? undefined : url.href;
}

function createAttempt(event: AttemptObservationEvent): AttemptState {
  return {
    attemptId: event.attemptId,
    requestId: event.requestId,
    keyId: event.keyId ?? null,
    routeId: event.routeId || 'unknown',
    upstreamId: event.upstreamId || 'unknown',
    provider: 'unknown', sent: false, llm: false, streaming: false, responseSeen: false, responseFailed: false,
    observationIncomplete: false, incompleteReasonLogged: false,
  };
}

function getAttempt(attempts: Map<string, AttemptState>, event: AttemptObservationEvent, logger: PluginLogger, onDrop: (attempt: AttemptState) => void): AttemptState {
  let attempt = attempts.get(event.attemptId);
  if (!attempt) {
    if (attempts.size >= MAX_ACTIVE_ATTEMPTS) {
      const oldest = attempts.keys().next().value as string | undefined;
      if (oldest !== undefined) { const dropped = attempts.get(oldest)!; attempts.delete(oldest); onDrop(dropped); }
      const now = Date.now();
      if (now - lastCapacityWarningAt >= LOG_INTERVAL_MS) {
        lastCapacityWarningAt = now;
        logger.warn('Token metering active attempt state capacity reached; oldest state dropped', { capacity: MAX_ACTIVE_ATTEMPTS });
      }
    }
    attempt = createAttempt(event);
    attempts.set(event.attemptId, attempt);
  }
  if (event.keyId !== undefined) attempt.keyId = event.keyId;
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
  keyId?: string | null;
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
  pricingProvider?: string;

}

function finalOutcome(input: FinalizationTaskInput, canonicalOutcome?: CanonicalEvent['outcome'], officialComplete = false): 'completed' | 'failed' | 'aborted' {
  if (input.endOutcome === 'cancelled') return 'aborted';
  if (input.endOutcome === 'failed' || !input.responseSeen || input.responseFailed || (input.observationIncomplete && !officialComplete) || canonicalOutcome === 'failed') return 'failed';
  if (canonicalOutcome === 'aborted' && !officialComplete) return 'aborted';
  return 'completed';
}

function finalizeAttempt(input: FinalizationTaskInput): TokenMeteringResult {
  let event = input.observedEvent;
  try {
    const finalized = input.endOutcome === 'completed' && input.responseSeen && !input.responseFailed && !input.observationIncomplete
      ? input.session?.finalizeCompletedStream() : input.session?.finalizeAbortedStream();
    if (finalized) {
      assertCanonicalTokenAccountingEventV2(finalized);
      event = mergeOfficialUsage(finalized, event);
    }
  } catch { /* preserve validated official observations */ }
  const officialComplete = event?.inputAuthority === 'official' && event?.outputAuthority === 'official' && event.inputTokens !== undefined && event.outputTokens !== undefined;
  const outcome = finalOutcome(input, event?.outcome, officialComplete);
  if (event) {
    event = { ...event, outcome, final: outcome === 'completed' };
    if ((input.responseFailed || input.observationIncomplete || !input.responseSeen) && !officialOnly(event)) {
      event.inputTokens = undefined; event.inputAuthority = 'none';
      event.outputTokens = undefined; event.outputAuthority = 'none';
    }
    assertCanonicalTokenAccountingEventV2(event);
  }
  const source = (value: number | undefined, authority: string | undefined) =>
    value === undefined || authority === 'none' ? 'none' : authority === 'official' ? 'official' : authority === 'partial' ? 'partial' : 'estimated';
  return Object.freeze({
    requestId: input.requestId, keyId: input.keyId ?? null, attemptId: input.attemptId, routeId: input.routeId, upstreamId: input.upstreamId,
    provider: input.provider, model: input.model, pricingProvider: input.pricingProvider,
    inputTokens: event?.inputTokens, outputTokens: event?.outputTokens,
    cacheReadTokens: event?.cacheReadTokens, cacheWriteTokens: event?.cacheWriteTokens,
    inputSource: source(event?.inputTokens, event?.inputAuthority), outputSource: source(event?.outputTokens, event?.outputAuthority),
    inputAuthority: event?.inputAuthority ?? 'none', outputAuthority: event?.outputAuthority ?? 'none',
    outcome, observationIncomplete: input.observationIncomplete,
    complete: outcome === 'completed' && event?.inputTokens !== undefined && event?.outputTokens !== undefined && event.inputAuthority !== 'partial' && event.outputAuthority !== 'partial' && (!input.observationIncomplete || (event.inputAuthority === 'official' && event.outputAuthority === 'official')),
    finishedAtMs: input.finishedAtMs, settlementVersion: 1,
  });
}

export const TokenMeteringPlugin = definePlugin(
  class implements Plugin {
    static readonly name = 'token-metering';
    static readonly version = '1.0.0';
    logger!: PluginLogger;
    private attempts = new Map<string, AttemptState>();
    private droppedAttempts = new Map<string, string>();
    private subscriptions = new Set<TokenMeteringSubscription>();
    private requests = new Map<string, readonly TokenMeteringSubscription[]>();
    private pending = new Set<Promise<void>>();
    private requiredPending = new Map<string, Set<Promise<void>>>();
    private closed = false;
    parsedResponses = 0;
    get activeAttempts(): number { return this.attempts.size; }
    async init(context: PluginInitContext): Promise<void> {
      if (context.scope && context.scope.type !== 'global') throw new Error('token-metering requires global scope');
      if (!context.services) throw new Error('token-metering requires plugin service host');
      this.logger = context.logger;
      const service: TokenMeteringService = Object.freeze({
        drainRequest: (requestId: string) => this.drainRequest(requestId),
        subscribe: (subscription: TokenMeteringSubscription) => {
          if (this.closed) throw new Error('token-metering disposed');
          this.subscriptions.add(subscription);
          if (subscription.requestId && this.requests.has(subscription.requestId)) {
            this.requests.set(subscription.requestId, Object.freeze([...this.requests.get(subscription.requestId)!, subscription]));
          }
          return () => {
            this.subscriptions.delete(subscription);
            // Request-specific subscriptions may be cancelled/reprepared before an attempt sends.
            // Already scheduled result promises retain their own subscriber and drain independently.
            if (subscription.requestId) {
              const captured = this.requests.get(subscription.requestId);
              if (captured) this.requests.set(subscription.requestId, Object.freeze(captured.filter(item => item !== subscription)));
            }
          };
        },
        prepareAttempt: (input: Parameters<TokenMeteringService['prepareAttempt']>[0]) => {
          if (this.closed) throw new Error('token-metering disposed');
          this.prepareRequest(input.requestId);
          if (!(this.requests.get(input.requestId)?.length)) return Object.freeze({ supported: false });
          let url: URL;
          try { url = new URL(input.url, 'http://token-metering-observation.invalid'); } catch { return Object.freeze({ supported: false }); }
          const body = parseRequestBody(input.body);
          if (!body) return Object.freeze({ supported: false });
          const classification = classifyRequest(url, body);
          if (!classification.provider) return Object.freeze({ supported: false });
          if (this.droppedAttempts.has(input.attemptId) || (!this.attempts.has(input.attemptId) && this.attempts.size >= MAX_ACTIVE_ATTEMPTS)) return Object.freeze({ supported: false });
          const attempt = getAttempt(this.attempts, { ...input, phase: 'selected', isActive: () => true }, this.logger, dropped => this.dropAttempt(dropped));
          attempt.llm = true; attempt.model = detectModel(body, url);
          attempt.pricingProvider = pricingProviderFromUrl(url);
          attempt.streaming = body.stream === true || /:streamgeneratecontent/i.test(url.pathname);
          ensureSession(attempt, classification.provider);
          // This prepared session is reused by the framework request event, never parsed twice.
          attempt.session!.consumeRequest({ body });
          return Object.freeze({ supported: true, provider: classification.provider, model: attempt.model, pricingProvider: attempt.pricingProvider });
        },
        prepareRequest: (requestId: string) => {
          if (this.closed) throw new Error('token-metering disposed');
          if (!this.requests.has(requestId)) this.requests.set(requestId, Object.freeze([...this.subscriptions].filter(s => !s.requestId || s.requestId === requestId)));
          return this.requests.get(requestId)!.length > 0;
        },
      });
      context.services.publish(TOKEN_METERING_SERVICE_ID, TOKEN_METERING_CONTRACT_VERSION, service);
    }
    bodyRequirements(context: import('@jeffusion/bungee-core/plugin').PluginBodyRequirementContext): import('@jeffusion/bungee-core/plugin').PluginBodyRequirements {
      const subscribed = this.requests.get(context.requestId) ?? [...this.subscriptions].filter(s => !s.requestId || s.requestId === context.requestId);
      return subscribed.length ? { request: 'none', observe: { request: true, response: true, sse: true } } : { request: 'none' };
    }

  register(hooks: PluginHooks): void {
      // Demand is captured before attempt selection; raw observation remains a framework hook.
      hooks.onRequestInit.tapPromise('token-metering-demand', async event => this.prepareRequest(event.requestId));
      hooks.onAttemptObservation.tapPromise('token-metering', async event => this.handleAttemptObservation(event));
    }
    private prepareRequest(requestId: string): void {
      if (!this.requests.has(requestId)) this.requests.set(requestId, Object.freeze([...this.subscriptions].filter(s => !s.requestId || s.requestId === requestId)));
    }
    private dropAttempt(attempt: AttemptState): void {
      this.droppedAttempts.set(attempt.attemptId, attempt.requestId);
      if (!attempt.sent) return;
      this.deliver(finalizeAttempt({ ...attempt, session: undefined, observedEvent: attempt.latestEvent ? { ...attempt.latestEvent } : undefined,
        finishedAtMs: Date.now(), endOutcome: 'failed', observationIncomplete: true }), !attempt.llm);
    }
    private async drainRequest(requestId: string): Promise<void> {
      // Required callbacks include settlement and its failure/recovery notification.
      // Degradable report subscribers and unrelated requests never enter this barrier.
      while (this.requiredPending.get(requestId)?.size) {
        await Promise.allSettled([...this.requiredPending.get(requestId)!]);
      }
    }
    private deliver(result: TokenMeteringResult, requiredOnly = false): void {
      for (const subscriber of this.requests.get(result.requestId) ?? []) {
        if (requiredOnly && !subscriber.required) continue;
        // Each subscriber has an independent promise; no consumer can block parsing or another consumer.
        const task = Promise.resolve().then(() => subscriber.onResult(result)).then(() => {}, async error => {
          try { await subscriber.onFailure?.(error, result); } catch { /* isolate consumer failure handlers */ }
        });
        this.pending.add(task);
        if (subscriber.required) {
          let required = this.requiredPending.get(result.requestId);
          if (!required) { required = new Set(); this.requiredPending.set(result.requestId, required); }
          required.add(task);
        }
        void task.finally(() => {
          this.pending.delete(task);
          const required = this.requiredPending.get(result.requestId);
          required?.delete(task);
          if (required?.size === 0) this.requiredPending.delete(result.requestId);
        });
      }
    }
    private async handleAttemptObservation(event: AttemptObservationEvent): Promise<void> {
      if (!event.isActive()) {
        this.attempts.delete(event.attemptId);
        return;
      }
      if (event.phase === 'request-end') {
        await this.drainRequest(event.requestId);
        this.requests.delete(event.requestId);
        for (const [id, requestId] of this.droppedAttempts) if (requestId === event.requestId) this.droppedAttempts.delete(id);
        return;
      }
      if (this.droppedAttempts.has(event.attemptId)) return;
      if (!this.requests.has(event.requestId)) this.prepareRequest(event.requestId);
      if (!(this.requests.get(event.requestId)?.length)) return;
      if (event.phase === 'selected') {
        getAttempt(this.attempts, event, this.logger, dropped => this.dropAttempt(dropped));
        return;
      }
      const attempt = event.phase === 'end'
        ? this.attempts.get(event.attemptId)
        : getAttempt(this.attempts, event, this.logger, dropped => this.dropAttempt(dropped));
      if (!attempt) return;

      if (event.phase === 'request') {
        markSent(attempt);
        let url: URL;
        try { url = new URL(event.url, 'http://token-metering-observation.invalid'); }
        catch { return; }
        attempt.pricingProvider = pricingProviderFromUrl(url);
        if (attempt.session) return;
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
        const provider = attempt.provider === 'unknown' ? classifyResponse(body, attempt.llm, event.envelope?.event) : attempt.provider;
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
          this.parsedResponses++;
          const parsed = event.protocol === 'json'
            ? session.consumeResponse({ body })
            : session.consumeStreamChunk({ chunk: body, event: event.envelope?.event });
          if (!parsed) return;
          assertCanonicalTokenAccountingEventV2(parsed);
          const merged = mergeOfficialUsage(parsed, attempt.latestEvent);
          attempt.latestEvent = attempt.responseFailed ? officialOnly(merged) : merged;
        } catch (error) {
          attempt.observationIncomplete = true;
          if (attempt.latestEvent) attempt.latestEvent = officialOnly(attempt.latestEvent);
          this.logger.debug('Failed to consume token metering attempt observation', { attemptId: event.attemptId, error });
        }
        return;
      }

      if (event.phase === 'incomplete') {
        if (!attempt.observationIncomplete) {
          attempt.observationIncomplete = true;
          if (!attempt.incompleteReasonLogged) {
            attempt.incompleteReasonLogged = true;
            this.logger.warn('Token metering attempt observation incomplete', { attemptId: event.attemptId, reason: event.reason });
          }
          if (attempt.latestEvent) attempt.latestEvent = officialOnly(attempt.latestEvent);
        }
        return;
      }

      if (event.phase === 'end') {
        if (event.sent) markSent(attempt);
        if (!event.isActive()) {
          this.attempts.delete(event.attemptId);
          return;
        }
        this.attempts.delete(event.attemptId);
        if (!attempt.sent) return;
        const taskInput: FinalizationTaskInput = {
          attemptId: attempt.attemptId,
          requestId: attempt.requestId,
          keyId: attempt.keyId ?? null,
          routeId: attempt.routeId,
          upstreamId: attempt.upstreamId,
          provider: attempt.provider,
          model: attempt.model,
          pricingProvider: attempt.pricingProvider,
          session: attempt.session,
          observedEvent: attempt.latestEvent ? { ...attempt.latestEvent } : undefined,
          finishedAtMs: Date.now(),
          endOutcome: event.outcome,
          responseSeen: attempt.responseSeen,
          responseFailed: attempt.responseFailed,
          observationIncomplete: attempt.observationIncomplete,
        };
        // Optional reporting needs a classified LLM attempt. Missing body views
        // cannot turn an ordinary API into a zero-token LLM request.
        this.deliver(finalizeAttempt(taskInput), !attempt.llm);
      }
    }

    async onDestroy(): Promise<void> {
      this.closed = true;
      await Promise.allSettled([...this.pending]);
      this.subscriptions.clear(); this.requests.clear(); this.attempts.clear(); this.droppedAttempts.clear(); this.requiredPending.clear();
    }
  }
);
export default TokenMeteringPlugin;
