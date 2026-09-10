import type { CredentialLease } from '../../../packages/core/src/plugin-control/contracts';
import type { FetchLike } from './oauth';
import { CODEX_MODELS_USER_AGENT, CODEX_MODELS_ORIGINATOR } from './constants';

export const USAGE_PATH = '/backend-api/wham/usage';
export const RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits';
export const CONSUME_RESET_CREDITS_PATH = '/backend-api/wham/rate-limit-reset-credits/consume';
export const USAGE_ORIGIN = 'https://chatgpt.com';
export const USAGE_USER_AGENT = CODEX_MODELS_USER_AGENT;
export const USAGE_ORIGINATOR = CODEX_MODELS_ORIGINATOR;
export const USAGE_ACCEPT = 'application/json';

const MAX_USAGE_BODY_BYTES = 256 * 1024;
const MAX_CONSUME_BODY_BYTES = 64 * 1024;
const MAX_TEXT_BYTES = 512;
const MAX_CREDITS = 256;
const CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 15_000;

export type ResourceState = 'fresh' | 'stale' | 'unavailable';
export type SafeUsageErrorCode =
  | 'timeout' | 'cancelled' | 'rate_limited' | 'upstream_forbidden'
  | 'upstream_unavailable' | 'invalid_response';

export interface UsageWindow {
  readonly usedPercent: number;
  readonly windowSeconds: number;
  readonly resetAfterSeconds: number;
  readonly resetAt: number;
}

export interface UsageSummary {
  readonly state: ResourceState;
  readonly planType?: string;
  readonly allowed?: boolean;
  readonly limitReached?: boolean;
  readonly availableCount?: number;
  readonly primary?: UsageWindow;
  readonly secondary?: UsageWindow;
  readonly error?: UsageErrorBody;
}

export interface ResetCredit {
  readonly id: string;
  readonly resetType: string;
  readonly status: 'available' | 'redeeming' | 'redeemed' | 'unknown';
  readonly grantedAt: number;
  readonly title?: string;
  readonly description?: string;
  readonly createdAt?: number;
  readonly expiresAt?: number;
  readonly redeemedAt?: number;
}

export interface ResetCreditsSummary {
  readonly state: ResourceState;
  readonly availableCount?: number;
  readonly credits?: readonly ResetCredit[];
  readonly error?: UsageErrorBody;
}

export interface UsageResult {
  readonly usage: UsageSummary;
  readonly resetCredits: ResetCreditsSummary;
}

export type ResetOutcome = 'reset' | 'nothing_to_reset' | 'no_credit' | 'already_redeemed' | 'reset_outcome_unknown';

export interface ResetResult {
  readonly outcome: ResetOutcome;
  readonly windowsReset: number;
  readonly usage?: UsageResult;
}

export interface UsageErrorBody {
  readonly code: SafeUsageErrorCode;
  readonly retryAfterSeconds?: number;
}

export class UsageError extends Error {
  readonly name = 'UsageError';
  constructor(readonly code: SafeUsageErrorCode | 'reauth_required' | 'disposed' | 'reset_in_progress' | 'credits_unavailable' | 'credit_unavailable' | 'stale_generation' | 'cancelled') {
    super(code);
  }
}

interface UsageDependencies {
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
  readonly timeoutMs?: number;
  readonly hostSignal: AbortSignal;
  readonly credential: (accountRef: string, signal: AbortSignal) => Promise<CredentialLease>;
  readonly rejectAccess: (accountRef: string, version: number) => Promise<boolean>;
}

interface ParsedResponse<T> {
  readonly value: T;
  readonly retryAfterSeconds?: number;
}

class UpstreamError extends Error {
  constructor(readonly code: SafeUsageErrorCode, readonly retryAfterSeconds?: number) { super(code); }
}

interface StoredSection<T> {
  readonly value?: T;
  readonly at?: number;
  readonly state: ResourceState;
  readonly error?: UsageErrorBody;
}

interface CacheEntry {
  readonly generation: number;
  readonly usage: StoredSection<Omit<UsageSummary, 'state' | 'error'>>;
  readonly resetCredits: StoredSection<Omit<ResetCreditsSummary, 'state' | 'error'>>;
}

interface GetOperation {
  readonly generation: number;
  readonly promise: Promise<UsageResult>;
  readonly controller: AbortController;
}

interface ResetOperation {
  readonly key: string;
  readonly promise: Promise<ResetResult>;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new UpstreamError('invalid_response');
  return value as Record<string, unknown>;
}

function boundedString(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT_BYTES || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new UpstreamError('invalid_response');
  }
  return value;
}

function finiteNumber(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new UpstreamError('invalid_response');
  return value;
}

function nonNegativeInteger(value: unknown, max = MAX_CREDITS): number {
  const number = finiteNumber(value);
  if (!Number.isSafeInteger(number) || number < 0 || number > max) throw new UpstreamError('invalid_response');
  return number;
}

function bool(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new UpstreamError('invalid_response');
  return value;
}

function epochMs(value: unknown): number {
  const parsed = typeof value === 'number'
    ? value < 1_000_000_000_000 ? value * 1000 : value
    : typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 8_640_000_000_000_000) throw new UpstreamError('invalid_response');
  return parsed;
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return boundedString(value);
}

function optionalEpochMs(value: unknown): number | undefined {
  return value === undefined || value === null ? undefined : epochMs(value);
}

function safeRetryAfter(value: string | null, now: number): number | undefined {
  if (value === null || value.trim() !== value || value.length === 0) return undefined;
  const seconds = /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= Number.MAX_SAFE_INTEGER ? seconds : undefined;
}

function sectionError(error: UpstreamError): UsageErrorBody {
  return error.retryAfterSeconds === undefined
    ? { code: error.code }
    : { code: error.code, retryAfterSeconds: error.retryAfterSeconds };
}

function cancelBody(response: Response): void {
  try { void response.body?.cancel().catch(() => undefined); } catch { /* body may already be locked or closed */ }
}

function parseWindow(value: unknown, now: number): UsageWindow {
  const input = object(value);
  const usedPercent = finiteNumber(input.used_percent);
  const windowSeconds = finiteNumber(input.limit_window_seconds ?? input.window_seconds);
  if (usedPercent < 0 || usedPercent > 100 || windowSeconds <= 0) throw new UpstreamError('invalid_response');
  const hasAfter = input.reset_after_seconds !== undefined;
  const hasAt = input.reset_at !== undefined;
  if (!hasAfter && !hasAt) throw new UpstreamError('invalid_response');
  const resetAfterSeconds = hasAfter ? finiteNumber(input.reset_after_seconds) : Math.max(0, (epochMs(input.reset_at) - now) / 1000);
  const resetAt = hasAt ? epochMs(input.reset_at) : now + resetAfterSeconds * 1000;
  if (resetAfterSeconds < 0 || !Number.isFinite(resetAfterSeconds) || !Number.isFinite(resetAt)) throw new UpstreamError('invalid_response');
  return { usedPercent, windowSeconds, resetAfterSeconds, resetAt };
}

function parseUsage(value: unknown, now: number): Omit<UsageSummary, 'state' | 'error'> {
  const input = object(value);
  const rate = input.rate_limit === undefined ? input : object(input.rate_limit);
  const result: { planType?: string; allowed?: boolean; limitReached?: boolean; availableCount?: number; primary?: UsageWindow; secondary?: UsageWindow } = {};
  if (input.plan_type !== undefined) result.planType = boundedString(input.plan_type);
  if (input.allowed !== undefined) result.allowed = bool(input.allowed);
  else if (rate.allowed !== undefined) result.allowed = bool(rate.allowed);
  if (input.limit_reached !== undefined) result.limitReached = bool(input.limit_reached);
  else if (rate.limit_reached !== undefined) result.limitReached = bool(rate.limit_reached);
  if (input.rate_limit_reset_credits !== undefined && input.rate_limit_reset_credits !== null) {
    const resetCredits = object(input.rate_limit_reset_credits);
    result.availableCount = nonNegativeInteger(resetCredits.available_count);
  }
  if (rate.primary_window !== undefined) result.primary = parseWindow(rate.primary_window, now);
  if (rate.secondary_window !== undefined) result.secondary = parseWindow(rate.secondary_window, now);
  if (result.planType === undefined && result.allowed === undefined && result.limitReached === undefined && result.availableCount === undefined
    && result.primary === undefined && result.secondary === undefined) throw new UpstreamError('invalid_response');
  return result;
}

function parseCredit(value: unknown): ResetCredit {
  const input = object(value);
  const id = boundedString(input.id);
  const resetType = boundedString(input.reset_type);
  const grantedAt = epochMs(input.granted_at);
  const rawStatus = input.status;
  if (rawStatus !== undefined && typeof rawStatus !== 'string') throw new UpstreamError('invalid_response');
  if (rawStatus === undefined) throw new UpstreamError('invalid_response');
  const status = rawStatus === 'available' || rawStatus === 'redeeming' || rawStatus === 'redeemed' ? rawStatus : 'unknown';
  const result: ResetCredit = { id, resetType, status, grantedAt };
  for (const [source, target] of [['title', 'title'], ['description', 'description']] as const) {
    const text = optionalText(input[source]);
    if (text !== undefined) (result as unknown as Record<string, unknown>)[target] = text;
  }
  const expiresAt = optionalEpochMs(input.expires_at);
  if (expiresAt !== undefined) (result as unknown as Record<string, unknown>).expiresAt = expiresAt;
  return result;
}

function parseResetCredits(value: unknown): Omit<ResetCreditsSummary, 'state' | 'error'> {
  const input = object(value);
  const availableCount = nonNegativeInteger(input.available_count);
  if (!Array.isArray(input.credits) || input.credits.length > MAX_CREDITS) throw new UpstreamError('invalid_response');
  const credits = input.credits.map(parseCredit).sort((a, b) => (a.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.expiresAt ?? Number.MAX_SAFE_INTEGER));
  return { availableCount, credits };
}

async function readJson(response: Response, signal: AbortSignal, maxBytes: number): Promise<unknown> {
  if (!response.body) return undefined;
  if (signal.aborted) throw new UsageError(signal.reason === 'timeout' ? 'timeout' : 'cancelled');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let total = 0;
  let onAbort!: () => void;
  const abort = new Promise<never>((_, reject) => {
    onAbort = () => reject(new UsageError(signal.reason === 'timeout' ? 'timeout' : 'cancelled'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    for (;;) {
      const next = await Promise.race([reader.read(), abort]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new UpstreamError('invalid_response');
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
  } catch (error) {
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    signal.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
  try { return JSON.parse(text); }
  catch { throw new UpstreamError('invalid_response'); }
}

function waitFor<T>(promise: Promise<T>, signal: AbortSignal, hostSignal: AbortSignal): Promise<T> {
  if (hostSignal.aborted) return Promise.reject(new UsageError('disposed'));
  if (signal.aborted) return Promise.reject(new UsageError('cancelled'));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => { signal.removeEventListener('abort', onCancel); hostSignal.removeEventListener('abort', onDispose); };
    const onCancel = () => { if (!settled) { settled = true; cleanup(); reject(new UsageError('cancelled')); } };
    const onDispose = () => { if (!settled) { settled = true; cleanup(); reject(new UsageError('disposed')); } };
    signal.addEventListener('abort', onCancel, { once: true });
    hostSignal.addEventListener('abort', onDispose, { once: true });
    promise.then((value) => { if (!settled) { settled = true; cleanup(); resolve(value); } }, (error) => { if (!settled) { settled = true; cleanup(); reject(error); } });
  });
}

export class UsageService {
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly gets = new Map<string, GetOperation>();
  private readonly resets = new Map<string, ResetOperation>();
  private readonly unknownReset = new Map<string, string>();
  private readonly epochs = new Map<string, number>();
  private readonly getControllers = new Map<string, AbortController>();
  private readonly hostAbortListener = () => this.dispose();

  constructor(private readonly deps: UsageDependencies) {
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = Math.max(1, deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    if (deps.hostSignal.aborted) this.dispose();
    else deps.hostSignal.addEventListener('abort', this.hostAbortListener, { once: true });
  }

  private epoch(accountRef: string): number { return this.epochs.get(accountRef) ?? 0; }

  private operationKey(accountRef: string, generation: number): string { return `${accountRef}\u0000${generation}`; }

  private invalidate(accountRef: string, abortGet = true): void {
    this.epochs.set(accountRef, this.epoch(accountRef) + 1);
    this.cache.delete(accountRef);
    for (const key of this.gets.keys()) {
      if (!key.startsWith(`${accountRef}\u0000`)) continue;
      if (abortGet) this.getControllers.get(key)?.abort('invalidated');
      this.getControllers.delete(key);
      this.gets.delete(key);
    }
  }

  invalidateAccount(accountRef: string): void { this.invalidate(accountRef); }

  private async requestJson(
    url: string,
    lease: CredentialLease,
    operationSignal: AbortSignal,
    method: 'GET' | 'POST',
    body?: Record<string, string>,
  ): Promise<ParsedResponse<unknown>> {
    if (operationSignal.aborted) throw new UsageError(this.deps.hostSignal.aborted ? 'disposed' : 'cancelled');
    const controller = new AbortController();
    let timedOut = false;
    let abortReject!: (error: UsageError) => void;
    const aborted = new Promise<never>((_, reject) => { abortReject = reject; });
    const onAbort = () => {
      controller.abort(operationSignal.reason);
      abortReject(new UsageError(this.deps.hostSignal.aborted ? 'disposed' : 'cancelled'));
    };
    operationSignal.addEventListener('abort', onAbort, { once: true });
    let timeoutReject!: (error: UpstreamError) => void;
    const timeout = new Promise<never>((_, reject) => { timeoutReject = reject; });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort('timeout');
      timeoutReject(new UpstreamError('timeout'));
    }, this.timeoutMs);
    try {
      const headers: Record<string, string> = {
        Authorization: lease.headers.Authorization,
        'Chatgpt-Account-Id': lease.headers['Chatgpt-Account-Id'],
        Accept: USAGE_ACCEPT,
        'User-Agent': USAGE_USER_AGENT,
        Originator: USAGE_ORIGINATOR,
      };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      let response: Response;
      try {
        response = await Promise.race([this.fetchImpl(url, {
          method,
          headers,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'manual',
          signal: controller.signal,
        }), timeout, aborted]);
      } catch {
        if (timedOut) throw new UpstreamError('timeout');
        if (operationSignal.aborted) throw new UsageError(this.deps.hostSignal.aborted ? 'disposed' : 'cancelled');
        throw new UpstreamError('upstream_unavailable');
      }
      const retryAfterSeconds = response.status === 429 ? safeRetryAfter(response.headers.get('retry-after'), this.now()) : undefined;
      if (response.status < 200 || response.status >= 300 || response.redirected) {
        cancelBody(response);
        if (response.status === 401) throw new UpstreamError('cancelled');
        if (response.status === 403) throw new UpstreamError('upstream_forbidden', retryAfterSeconds);
        if (response.status === 429) throw new UpstreamError('rate_limited', retryAfterSeconds);
        throw new UpstreamError('upstream_unavailable');
      }
      const parsed = await readJson(response, controller.signal, method === 'POST' ? MAX_CONSUME_BODY_BYTES : MAX_USAGE_BODY_BYTES);
      return { value: parsed, retryAfterSeconds };
    } catch (error) {
      if (timedOut && !(error instanceof UsageError)) throw new UpstreamError('timeout');
      throw error;
    } finally {
      clearTimeout(timer);
      operationSignal.removeEventListener('abort', onAbort);
    }
  }

  private async rejectOnce(accountRef: string, version: number): Promise<never> {
    this.invalidate(accountRef, false);
    let rejected: boolean;
    try { rejected = await this.deps.rejectAccess(accountRef, version); }
    catch { throw new UsageError('upstream_unavailable'); }
    throw new UsageError(rejected ? 'reauth_required' : 'stale_generation');
  }

  private async runGet(accountRef: string, lease: CredentialLease, signal: AbortSignal, operationEpoch: number): Promise<UsageResult> {
    const previous = this.cache.get(accountRef);
    const previousUsable = previous?.generation === lease.version && previous.usage.value !== undefined;
    const previousCreditsUsable = previous?.generation === lease.version && previous.resetCredits.value !== undefined;
    const [usage, credits] = await Promise.allSettled([
      this.requestJson(`${USAGE_ORIGIN}${USAGE_PATH}`, lease, signal, 'GET'),
      this.requestJson(`${USAGE_ORIGIN}${RESET_CREDITS_PATH}`, lease, signal, 'GET'),
    ]);
    if (this.deps.hostSignal.aborted) throw new UsageError('disposed');
    const unauthorized = [usage, credits].some((item) => item.status === 'rejected' && item.reason instanceof UpstreamError && item.reason.code === 'cancelled');
    if (unauthorized) return this.rejectOnce(accountRef, lease.version);
    let usageError = usage.status === 'rejected' ? usage.reason : undefined;
    let creditsError = credits.status === 'rejected' ? credits.reason : undefined;
    let usageValue: Omit<UsageSummary, 'state' | 'error'> | undefined;
    let creditsValue: Omit<ResetCreditsSummary, 'state' | 'error'> | undefined;
    let usageParseError: UpstreamError | undefined;
    let creditsParseError: UpstreamError | undefined;
    if (usage.status === 'fulfilled') {
      try { usageValue = parseUsage(usage.value.value, this.now()); }
      catch (error) { usageParseError = error instanceof UpstreamError ? error : new UpstreamError('invalid_response'); }
    }
    if (credits.status === 'fulfilled') {
      try { creditsValue = parseResetCredits(credits.value.value); }
      catch (error) { creditsParseError = error instanceof UpstreamError ? error : new UpstreamError('invalid_response'); }
    }
    if (usageParseError !== undefined) usageError = usageParseError;
    if (creditsParseError !== undefined) creditsError = creditsParseError;
    const usageFailure = usageError instanceof UpstreamError ? sectionError(usageError) : usageError instanceof UsageError ? { code: usageError.code === 'timeout' ? 'timeout' : 'cancelled' } as UsageErrorBody : { code: 'invalid_response' as const };
    const creditsFailure = creditsError instanceof UpstreamError ? sectionError(creditsError) : creditsError instanceof UsageError ? { code: creditsError.code === 'timeout' ? 'timeout' : 'cancelled' } as UsageErrorBody : { code: 'invalid_response' as const };
    const usageSection: UsageSummary = usageValue !== undefined
      ? { state: 'fresh', ...usageValue }
      : previousUsable && previous?.usage.value !== undefined
      ? { state: 'stale', ...previous.usage.value, error: usageFailure }
      : { state: 'unavailable', error: usageFailure };
    const creditsSection: ResetCreditsSummary = creditsValue !== undefined
      ? { state: 'fresh', ...creditsValue }
      : previousCreditsUsable && previous?.resetCredits.value !== undefined
      ? { state: 'stale', ...previous.resetCredits.value, error: creditsFailure }
      : { state: 'unavailable', error: creditsFailure };
    const result = { usage: usageSection, resetCredits: creditsSection };
    if (this.epoch(accountRef) === operationEpoch && !this.deps.hostSignal.aborted) {
      this.cache.set(accountRef, {
        generation: lease.version,
        usage: usageValue === undefined
          ? { state: usageSection.state, value: previousUsable ? previous?.usage.value : undefined, at: previousUsable ? previous?.usage.at : undefined, error: usageSection.error }
          : { state: 'fresh', value: usageValue, at: this.now() },
        resetCredits: creditsValue === undefined
          ? { state: creditsSection.state, value: previousCreditsUsable ? previous?.resetCredits.value : undefined, at: previousCreditsUsable ? previous?.resetCredits.at : undefined, error: creditsSection.error }
          : { state: 'fresh', value: creditsValue, at: this.now() },
      });
    }
    return result;
  }

  async get(accountRef: string, signal: AbortSignal, options: { forceFresh?: boolean; retry?: number } = {}): Promise<UsageResult> {
    const lease = await waitFor(this.deps.credential(accountRef, signal), signal, this.deps.hostSignal);
    const cached = this.cache.get(accountRef);
    if (!options.forceFresh && cached?.generation === lease.version) {
      const usageValid = cached.usage.state === 'fresh' && cached.usage.at !== undefined && this.now() - cached.usage.at <= CACHE_TTL_MS;
      const creditsValid = cached.resetCredits.state === 'fresh' && cached.resetCredits.at !== undefined && this.now() - cached.resetCredits.at <= CACHE_TTL_MS;
      if (usageValid && creditsValid) {
        return {
          usage: cached.usage.value === undefined ? { state: cached.usage.state, error: cached.usage.error } : { state: cached.usage.state, ...cached.usage.value, ...(cached.usage.error ? { error: cached.usage.error } : {}) },
          resetCredits: cached.resetCredits.value === undefined ? { state: cached.resetCredits.state, error: cached.resetCredits.error } : { state: cached.resetCredits.state, ...cached.resetCredits.value, ...(cached.resetCredits.error ? { error: cached.resetCredits.error } : {}) },
        };
      }
    }
    const operationKey = this.operationKey(accountRef, lease.version);
    let operation = this.gets.get(operationKey);
    if (operation === undefined) {
      const controller = new AbortController();
      this.getControllers.set(operationKey, controller);
      const epoch = this.epoch(accountRef);
      const promise = this.runGet(accountRef, lease, controller.signal, epoch).finally(() => {
        if (this.gets.get(operationKey)?.promise === promise) this.gets.delete(operationKey);
        if (this.getControllers.get(operationKey) === controller) this.getControllers.delete(operationKey);
      });
      operation = { generation: lease.version, controller, promise };
      this.gets.set(operationKey, operation);
    }
    const result = await waitFor(operation.promise, signal, this.deps.hostSignal);
    const latest = await waitFor(this.deps.credential(accountRef, signal), signal, this.deps.hostSignal);
    if (latest.version !== lease.version) {
      this.invalidate(accountRef);
      if ((options.retry ?? 0) >= 2) throw new UsageError('stale_generation');
      return this.get(accountRef, signal, { forceFresh: true, retry: (options.retry ?? 0) + 1 });
    }
    return result;
  }

  private resetKey(redeemRequestId: string, creditId: string): string { return `${redeemRequestId}\u0000${creditId}`; }

  private async runReset(accountRef: string, lease: CredentialLease, key: string, body: Record<string, string>): Promise<ResetResult> {
    let outcome: ResetOutcome;
    let windowsReset = 0;
    try {
      const response = await this.requestJson(`${USAGE_ORIGIN}${CONSUME_RESET_CREDITS_PATH}`, lease, this.deps.hostSignal, 'POST', body);
      const input = object(response.value);
      const code = input.code;
      if (input.windows_reset !== undefined && input.windows_reset !== null) windowsReset = nonNegativeInteger(input.windows_reset, Number.MAX_SAFE_INTEGER);
      outcome = code === 'reset' ? 'reset'
        : code === 'already_redeemed' ? 'already_redeemed'
        : code === 'nothing_to_reset' ? 'nothing_to_reset'
        : code === 'no_credit' ? 'no_credit'
        : 'reset_outcome_unknown';
    } catch (error) {
      if (error instanceof UpstreamError && error.code === 'cancelled') await this.rejectOnce(accountRef, lease.version);
      outcome = 'reset_outcome_unknown';
    }
    this.invalidate(accountRef);
    if (outcome === 'reset_outcome_unknown') this.unknownReset.set(accountRef, key);
    else this.unknownReset.delete(accountRef);
    let usage: UsageResult | undefined;
    try { usage = await this.get(accountRef, this.deps.hostSignal, { forceFresh: true }); }
    catch { /* consume outcome is authoritative; the refresh is best effort and host-owned */ }
    return { outcome, windowsReset, ...(usage === undefined ? {} : { usage }) };
  }

  async consume(
    accountRef: string,
    redeemRequestId: string,
    creditId: string,
    signal: AbortSignal,
  ): Promise<ResetResult> {
    const key = this.resetKey(redeemRequestId, creditId);
    const active = this.resets.get(accountRef);
    if (active !== undefined) {
      if (active.key !== key) throw new UsageError('reset_in_progress');
      return waitFor(active.promise, signal, this.deps.hostSignal);
    }
    const blocked = this.unknownReset.get(accountRef);
    if (blocked !== undefined && blocked !== key) throw new UsageError('reset_in_progress');
    const retryingUnknown = blocked === key;
    let resolveOperation!: (result: ResetResult) => void;
    let rejectOperation!: (error: unknown) => void;
    const promise = new Promise<ResetResult>((resolve, reject) => { resolveOperation = resolve; rejectOperation = reject; });
    this.resets.set(accountRef, { key, promise });
    void (async () => {
      try {
        let lease: CredentialLease;
        if (retryingUnknown) {
          lease = await this.deps.credential(accountRef, this.deps.hostSignal);
        } else {
          const current = await this.get(accountRef, this.deps.hostSignal, { forceFresh: true });
          if (current.resetCredits.state !== 'fresh' || current.resetCredits.availableCount === undefined) throw new UsageError('credits_unavailable');
          const selected = current.resetCredits.credits?.find((item) => item.id === creditId);
          if (current.resetCredits.availableCount <= 0 || selected?.status !== 'available') throw new UsageError('credit_unavailable');
          lease = await this.deps.credential(accountRef, this.deps.hostSignal);
        }
        this.invalidate(accountRef);
        resolveOperation(await this.runReset(accountRef, lease, key, { redeem_request_id: redeemRequestId, credit_id: creditId }));
      } catch (error) {
        rejectOperation(error);
      } finally {
        if (this.resets.get(accountRef)?.promise === promise) this.resets.delete(accountRef);
      }
    })();
    return waitFor(promise, signal, this.deps.hostSignal);
  }

  dispose(): void {
    this.deps.hostSignal.removeEventListener('abort', this.hostAbortListener);
    for (const controller of this.getControllers.values()) controller.abort('disposed');
    this.getControllers.clear();
    this.gets.clear();
    this.cache.clear();
    this.resets.clear();
    this.unknownReset.clear();
  }
}
