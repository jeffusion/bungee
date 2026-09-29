import type {
  CanonicalTokenAccountingEventV2,
  TokenAccountingAuthority,
  TokenAccountingOutcome,
  TokenAccountingSessionState
} from './types';
import { TOKEN_ACCOUNTING_AUTHORITIES } from './types';
import { getEncoding, type Tiktoken } from 'js-tiktoken';

type JsonRecord = Record<string, unknown>;

type EncodingType = 'cl100k_base' | 'o200k_base';

const MODEL_ENCODING_MAP: Record<string, EncodingType> = {
  'gpt-4o': 'o200k_base',
  'gpt-4o-mini': 'o200k_base',
  'gpt-4.1': 'o200k_base',
  'gpt-4.1-mini': 'o200k_base',
  'gpt-4.1-nano': 'o200k_base',
  'o1': 'o200k_base',
  'o1-mini': 'o200k_base',
  'o1-preview': 'o200k_base',
  'o3': 'o200k_base',
  'o3-mini': 'o200k_base',
  'gpt-4': 'cl100k_base',
  'gpt-4-turbo': 'cl100k_base',
  'gpt-4-32k': 'cl100k_base',
  'gpt-3.5-turbo': 'cl100k_base',
  'gpt-3.5': 'cl100k_base',
  claude: 'cl100k_base',
  'claude-3': 'cl100k_base',
  'claude-3.5': 'cl100k_base',
  gemini: 'cl100k_base',
  'gemini-1.5': 'cl100k_base',
  'gemini-2.0': 'cl100k_base',
  'gemini-2.5': 'cl100k_base'
};

const encodingCache = new Map<EncodingType, Tiktoken>();

const CANONICAL_EVENT_KEYS = new Set([
  'requestId',
  'attemptId',
  'routeId',
  'upstreamId',
  'provider',
  'model',
  'streaming',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'inputAuthority',
  'outputAuthority',
  'final',
  'outcome',
  'countedAt'
]);

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function readNumber(record: JsonRecord | undefined, key: string): number | undefined {
  if (!record) {
    return undefined;
  }

  const value = record[key];
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

export function readRecord(record: JsonRecord | undefined, key: string): JsonRecord | undefined {
  if (!record) {
    return undefined;
  }

  const value = record[key];
  return isRecord(value) ? value : undefined;
}

export function countTextTokens(text: string): number {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(text.length / 4));
}

function getEncodingForModel(model: string): EncodingType {
  const normalizedModel = model.trim().toLowerCase();
  if (MODEL_ENCODING_MAP[normalizedModel]) {
    return MODEL_ENCODING_MAP[normalizedModel];
  }

  for (const [prefix, encoding] of Object.entries(MODEL_ENCODING_MAP)) {
    if (normalizedModel.startsWith(prefix)) {
      return encoding;
    }
  }

  return 'cl100k_base';
}

function getEncodingCached(type: EncodingType): Tiktoken {
  let encoding = encodingCache.get(type);
  if (!encoding) {
    encoding = getEncoding(type);
    encodingCache.set(type, encoding);
  }

  return encoding;
}

export function countModelTextTokens(text: string, model?: string): number {
  if (!text) {
    return 0;
  }

  if (!model) {
    return countTextTokens(text);
  }

  try {
    const encoding = getEncodingCached(getEncodingForModel(model));
    return encoding.encode(text).length;
  } catch {
    return countTextTokens(text);
  }
}

export function countJsonLikeTokens(value: unknown): number {
  if (typeof value === 'string') {
    return countTextTokens(value);
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return 1;
  }

  if (value === null || value === undefined) {
    return 0;
  }

  if (Array.isArray(value)) {
    return value.reduce((sum, entry) => sum + countJsonLikeTokens(entry), 0);
  }

  if (isRecord(value)) {
    return Object.entries(value).reduce((sum, [key, entry]) => {
      return sum + countTextTokens(key) + countJsonLikeTokens(entry);
    }, 0);
  }

  return countTextTokens(String(value));
}

export function clampTokens(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  return Number.isFinite(value) ? Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(value))) : undefined;
}

export function buildBaseEvent(
  state: TokenAccountingSessionState,
  overrides: Partial<CanonicalTokenAccountingEventV2>
): CanonicalTokenAccountingEventV2 {
  return {
    requestId: state.requestId,
    attemptId: state.attemptId,
    routeId: state.routeId,
    upstreamId: state.upstreamId,
    provider: state.provider,
    model: state.model ?? 'unknown',
    streaming: state.streaming,
    inputAuthority: 'none',
    outputAuthority: 'none',
    final: false,
    outcome: 'completed',
    countedAt: new Date().toISOString(),
    ...overrides
  };
}

export function createPartialTokenAccountingEvent(
  state: TokenAccountingSessionState,
  overrides: Partial<CanonicalTokenAccountingEventV2> = {}
): CanonicalTokenAccountingEventV2 {
  return buildBaseEvent(state, {
    final: false,
    outcome: 'completed',
    ...overrides
  });
}

export function finalizeTokenAccountingEvent(
  state: TokenAccountingSessionState,
  overrides: Partial<CanonicalTokenAccountingEventV2> = {},
  outcome: TokenAccountingOutcome = 'completed'
): CanonicalTokenAccountingEventV2 {
  const isCompleted = outcome === 'completed';
  return buildBaseEvent(state, {
    final: isCompleted,
    outcome,
    ...overrides
  });
}

export function assertCanonicalTokenAccountingEventV2(
  event: unknown
): asserts event is CanonicalTokenAccountingEventV2 {
  if (!isRecord(event)) {
    throw new Error('Canonical token accounting event must be an object.');
  }

  for (const key of Object.keys(event)) {
    if (!CANONICAL_EVENT_KEYS.has(key)) {
      throw new Error(`Unexpected aggregate or legacy token accounting field: ${key}`);
    }
  }

  for (const key of ['requestId', 'attemptId', 'routeId', 'upstreamId', 'provider', 'model', 'countedAt']) {
    if (typeof event[key] !== 'string' || event[key].length === 0) {
      throw new Error(`Canonical token accounting event requires non-empty string field: ${key}`);
    }
  }

  if (typeof event.streaming !== 'boolean') {
    throw new Error('Canonical token accounting event requires boolean field: streaming');
  }

  if (typeof event.final !== 'boolean') {
    throw new Error('Canonical token accounting event requires boolean field: final');
  }

  if (event.outcome !== 'completed' && event.outcome !== 'aborted' && event.outcome !== 'failed') {
    throw new Error('Canonical token accounting event requires outcome completed|aborted|failed.');
  }

  if (event.final && event.outcome === 'aborted') {
    throw new Error('Aborted token accounting events must not be final.');
  }

  if (!TOKEN_ACCOUNTING_AUTHORITIES.includes(event.inputAuthority as TokenAccountingAuthority)) {
    throw new Error('Canonical token accounting event has invalid inputAuthority.');
  }

  if (!TOKEN_ACCOUNTING_AUTHORITIES.includes(event.outputAuthority as TokenAccountingAuthority)) {
    throw new Error('Canonical token accounting event has invalid outputAuthority.');
  }

  for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as const) {
    if (event[key] !== undefined && !(typeof event[key] === 'number' && Number.isSafeInteger(event[key]) && event[key] >= 0)) {
      throw new Error(`Canonical token accounting event has invalid numeric field: ${key}`);
    }
  }

  if (Object.prototype.hasOwnProperty.call(event, 'source')) {
    throw new Error('Legacy source/hybrid semantics are not allowed in canonical token accounting events.');
  }

  if (Object.prototype.hasOwnProperty.call(event, 'logicalRequests') || Object.prototype.hasOwnProperty.call(event, 'upstreamAttempts')) {
    throw new Error('Plugin aggregate fields logicalRequests/upstreamAttempts must not appear on single llms events.');
  }

  if (event.inputAuthority === 'official') {
    if (!(typeof event.inputTokens === 'number' && Number.isSafeInteger(event.inputTokens) && event.inputTokens >= 0)) {
      throw new Error('Official inputAuthority requires inputTokens.');
    }

  }

  if (event.outputAuthority === 'official' && !(typeof event.outputTokens === 'number' && Number.isSafeInteger(event.outputTokens) && event.outputTokens >= 0)) {
    throw new Error('Official outputAuthority requires outputTokens.');
  }
}
