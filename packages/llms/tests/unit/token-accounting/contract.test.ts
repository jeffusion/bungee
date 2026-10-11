import { describe, expect, test } from 'bun:test';
import * as llmsPluginApi from '@jeffusion/bungee-llms/plugin-api';

type TokenAccountingAuthority = 'official' | 'local' | 'heuristic' | 'partial' | 'none';
type TokenAccountingOutcome = 'completed' | 'aborted' | 'failed';

type CanonicalTokenAccountingEventV2 = {
  requestId: string;
  attemptId: string;
  routeId: string;
  upstreamId: string;
  provider: string;
  model: string;
  streaming: boolean;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  inputAuthority: TokenAccountingAuthority;
  outputAuthority: TokenAccountingAuthority;
  final: boolean;
  outcome: TokenAccountingOutcome;
  countedAt: string;
};

type AssertCanonicalTokenAccountingEventV2 = (
  event: unknown
) => asserts event is CanonicalTokenAccountingEventV2;

function getAssertCanonicalTokenAccountingEventV2(): AssertCanonicalTokenAccountingEventV2 {
  if (!Reflect.has(llmsPluginApi, 'assertCanonicalTokenAccountingEventV2')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export assertCanonicalTokenAccountingEventV2 for the canonical token accounting v2 contract.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'assertCanonicalTokenAccountingEventV2'
  ) as AssertCanonicalTokenAccountingEventV2;
}

function getTokenAccountingAuthorities(): readonly TokenAccountingAuthority[] {
  if (!Reflect.has(llmsPluginApi, 'TOKEN_ACCOUNTING_AUTHORITIES')) {
    throw new Error(
      'Stable facade @jeffusion/bungee-llms/plugin-api must export TOKEN_ACCOUNTING_AUTHORITIES with official/local/heuristic/partial/none for the canonical token accounting v2 contract.'
    );
  }

  return Reflect.get(
    llmsPluginApi,
    'TOKEN_ACCOUNTING_AUTHORITIES'
  ) as readonly TokenAccountingAuthority[];
}

function createFinalEvent(
  overrides: Partial<CanonicalTokenAccountingEventV2> = {}
): CanonicalTokenAccountingEventV2 {
  return {
    requestId: 'req_1',
    attemptId: 'attempt_1',
    routeId: 'chat',
    upstreamId: 'openai-primary',
    provider: 'openai',
    model: 'gpt-4.1',
    streaming: false,
    inputTokens: 120,
    outputTokens: 32,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    inputAuthority: 'official',
    outputAuthority: 'official',
    final: true,
    outcome: 'completed',
    countedAt: '2026-04-09T16:00:00.000Z',
    ...overrides
  };
}

function createAbortedStreamEvent(
  overrides: Partial<CanonicalTokenAccountingEventV2> = {}
): CanonicalTokenAccountingEventV2 {
  return {
    requestId: 'req_2',
    attemptId: 'attempt_2',
    routeId: 'chat',
    upstreamId: 'anthropic-primary',
    provider: 'anthropic',
    model: 'claude-3-7-sonnet',
    streaming: true,
    inputTokens: 88,
    outputTokens: 21,
    inputAuthority: 'official',
    outputAuthority: 'partial',
    final: false,
    outcome: 'aborted',
    countedAt: '2026-04-09T16:01:00.000Z',
    ...overrides
  };
}

describe('token accounting v2 canonical contract', () => {
  test('exposes v2 canonical validator and authority enum only through stable plugin-api facade', () => {
    expect(getTokenAccountingAuthorities()).toEqual([
      'official',
      'local',
      'heuristic',
      'partial',
      'none'
    ]);

    expect(getAssertCanonicalTokenAccountingEventV2()).toEqual(expect.any(Function));
  });

  test('accepts the exact canonical llms accounting event fields required by the plan', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    const finalEvent = createFinalEvent({
      cacheReadTokens: 17,
      cacheWriteTokens: 0
    });

    expect(() => assertCanonicalTokenAccountingEventV2(finalEvent)).not.toThrow();
    expect(finalEvent).toEqual({
      requestId: 'req_1',
      attemptId: 'attempt_1',
      routeId: 'chat',
      upstreamId: 'openai-primary',
      provider: 'openai',
      model: 'gpt-4.1',
      streaming: false,
      inputTokens: 120,
      outputTokens: 32,
      cacheReadTokens: 17,
      cacheWriteTokens: 0,
      inputAuthority: 'official',
      outputAuthority: 'official',
      final: true,
      outcome: 'completed',
      countedAt: '2026-04-09T16:00:00.000Z'
    });
    expect(finalEvent).not.toHaveProperty('source');
    expect(finalEvent).not.toHaveProperty('logicalRequests');
    expect(finalEvent).not.toHaveProperty('upstreamAttempts');
  });

  test('models an aborted stream with final plus outcome instead of extra canonical fields', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    const abortedStreamEvent = createAbortedStreamEvent();

    expect(() => assertCanonicalTokenAccountingEventV2(abortedStreamEvent)).not.toThrow();
    expect(abortedStreamEvent.final).toBe(false);
    expect(abortedStreamEvent.outcome).toBe('aborted');
    expect(abortedStreamEvent.streaming).toBe(true);
  });

  test('rejects legacy source hybrid semantics because v2 must split input and output authority', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    const legacyHybridShape = {
      ...createFinalEvent(),
      source: 'hybrid'
    };

    expect(() => assertCanonicalTokenAccountingEventV2(legacyHybridShape)).toThrow(/hybrid|source|authority/i);
  });

  test('rejects plugin aggregation fields on a single llms accounting event', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    const aggregatePayload = {
      ...createFinalEvent(),
      logicalRequests: 1,
      upstreamAttempts: 2
    };

    expect(() => assertCanonicalTokenAccountingEventV2(aggregatePayload)).toThrow(/logicalRequests|upstreamAttempts|aggregate/i);
  });

  test('rejects contradictory final-outcome semantics and preserves unknown cache versus explicit zero', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    const contradictoryEvent = createAbortedStreamEvent({
      final: true,
      outcome: 'aborted'
    });
    const missingCacheValue = createFinalEvent({
      cacheReadTokens: undefined,
      inputAuthority: 'official'
    });
    const explicitZeroCache = createFinalEvent({
      cacheWriteTokens: 0
    });

    expect(() => assertCanonicalTokenAccountingEventV2(contradictoryEvent)).toThrow(/final|outcome|aborted/i);
    expect(() => assertCanonicalTokenAccountingEventV2(missingCacheValue)).not.toThrow();
    expect(missingCacheValue.cacheReadTokens).toBeUndefined();
    expect(() => assertCanonicalTokenAccountingEventV2(explicitZeroCache)).not.toThrow();
  });

  test('rejects negative, fractional, and unsafe token counts', () => {
    const assertCanonicalTokenAccountingEventV2 = getAssertCanonicalTokenAccountingEventV2();
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertCanonicalTokenAccountingEventV2(createFinalEvent({ inputTokens: value }))).toThrow(/numeric field|inputTokens/i);
    }
  });
});
